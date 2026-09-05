import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActorMesh } from "../actor/actor-mesh.js";
import { CONTEXT_SELECTIONS, resolveContextSelection } from "../actor/context-selection.js";
import {
  type EventResource,
  normalizeEventResource,
  resourceKey,
} from "../actor/event-subscriptions.js";
import type { ActorWakeScheduler } from "../actor/os-scheduler.js";
import type { RootControlService } from "../actor/root-control.js";
import { summarizeCharter } from "../actor/worker-prompt.js";
import { DEFAULT_CODER_POOL, type ModelConfigInput } from "../providers/model-config.js";
import { githubBranchReference } from "../references/reference.js";
import { toolError, toolOk } from "./result.js";
import { HUMAN_OPERATOR, isHumanOperator } from "./stamp.js";
import { createMcpServer } from "./strict-server.js";

export const AGENT_EXEC_MCP_NAME = "mesh";

const providerModelConfigSchema = z.object({
  provider: z.string().describe("Coding harness, e.g. 'claude', 'antigravity', 'codex', 'kimi'."),
  model: z
    .string()
    .optional()
    .describe("Model/tier id for the harness. Omit to use the provider's default model."),
  effort: z
    .string()
    .optional()
    .describe(
      "Optional provider-native reasoning level (for example 'high' or 'xhigh'). Omit to preserve the provider/model default."
    ),
});

/**
 * A single provider/model/effort choice, or an ordered pool of acceptable
 * choices tried earliest-available first. A pool longer than one entry
 * requires a portable (ledger/tail) actor — a native provider session can't
 * move between candidates.
 */
const modelConfigSchema = z.union([
  providerModelConfigSchema,
  z.array(providerModelConfigSchema).min(1),
]);

/**
 * The agent-execution MCP server — the actor mesh's primitive (design B.4)
 * exposed as tools: spawn children, message any thread you hold a handle to,
 * introduce peers, see your reports, and retire a child.
 *
 * **One server instance per actor**, with that actor's id (`selfId`) baked in, so
 * "who is acting" is the unspoofable endpoint identity, not a tool argument the
 * model fills in. The mesh routes by id (the id *is* the capability); this server
 * just attributes every call to its owner and enforces the ownership tree for the
 * one authority that matters — retirement.
 */
export function createAgentExecMcpServer(
  mesh: ActorMesh,
  selfId: string,
  rootId: string,
  wakeScheduler?: ActorWakeScheduler,
  options?: {
    onWrite?: () => void;
    rootControl?: RootControlService;
    isFenced?: () => boolean;
  }
): McpServer {
  const server = createMcpServer(
    { name: AGENT_EXEC_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced ?? (() => mesh.isYielded(selfId)) }
  );

  const eventResourceInputSchema = {
    source: z
      .string()
      .optional()
      .describe(
        "Canonical URL-style reference string, e.g. github:owner/repo, github:owner/repo/issues/123, gchat:spaces/ABC, system:events."
      ),
    kind: z
      .enum([
        "github_org",
        "github_repo",
        "github_issue",
        "github_pr",
        "github_branch",
        "chat",
        "chat_space",
        "system",
      ])
      .optional()
      .describe("Legacy event source kind."),
    org: z.string().optional().describe("The organization name (required for github_org)."),
    repo: z
      .string()
      .optional()
      .describe(
        "The repository owner/name (required for github_repo, github_issue, github_pr, github_branch)."
      ),
    number: z
      .number()
      .optional()
      .describe("The issue/PR number (required for github_issue, github_pr)."),
    ref: z
      .string()
      .optional()
      .describe(
        "The fully qualified git ref, e.g. refs/heads/staging (required for github_branch)."
      ),
    space: z.string().optional().describe("The space name (required for chat_space)."),
  };

  const parseEventResource = (
    args: {
      source?: string;
      kind?:
        | "github_org"
        | "github_repo"
        | "github_issue"
        | "github_pr"
        | "github_branch"
        | "chat"
        | "chat_space"
        | "system";
      org?: string;
      repo?: string;
      number?: number;
      ref?: string;
      space?: string;
    },
    action = "subscription"
  ): EventResource => {
    if (args.source) {
      return normalizeEventResource(args.source);
    }
    const { kind, org, repo, number, ref, space } = args;
    if (!kind) {
      throw new Error(`source or kind is required for ${action}`);
    }
    if (kind === "chat") {
      return "gchat:spaces";
    }
    if (kind === "system") {
      return "system:events";
    }
    if (kind === "chat_space") {
      if (!space) throw new Error(`space is required for chat_space ${action}`);
      return `gchat:${space.startsWith("spaces/") ? space : `spaces/${space}`}`;
    }
    if (kind === "github_org") {
      if (!org) throw new Error(`org is required for github_org ${action}`);
      return `github:${org}`;
    }
    if (kind === "github_repo") {
      if (!repo) throw new Error(`repo is required for github_repo ${action}`);
      return `github:${repo}`;
    }
    if (kind === "github_branch") {
      if (!repo) throw new Error(`repo is required for github_branch ${action}`);
      if (!ref) throw new Error(`ref is required for github_branch ${action}`);
      return githubBranchReference(repo, ref);
    }
    if (!repo) throw new Error(`repo is required for ${kind} ${action}`);
    if (number === undefined) throw new Error(`number is required for ${kind} ${action}`);
    return `github:${repo}/${kind === "github_pr" ? "pulls" : "issues"}/${number}`;
  };

  const rec = mesh.actors.get(selfId);
  if (rec?.humanUnlocked) {
    server.registerTool(
      "reply",
      {
        title: "Reply to the human operator",
        description: "Reply to the human operator in your conversation thread.",
        inputSchema: {
          message: z.string().describe("The message to send back to the human operator."),
        },
      },
      async ({ message }) => {
        try {
          const r = mesh.actors.get(selfId);
          const sessionId = r?.lastChatSessionId ?? "default-session";
          mesh.recordMessageEmitted({
            fromId: selfId,
            toId: HUMAN_OPERATOR,
            body: message,
            sessionId,
            isDrop: false,
          });
          options?.onWrite?.();
          return toolOk("sent");
        } catch (err) {
          return toolError(err);
        }
      }
    );
  }

  server.registerTool(
    "spawn_thread",
    {
      title: "Spawn a worker thread",
      description:
        "Create a child actor that owns the given charter and runs in its own session and its own private working directory. Returns its thread_id. You become its parent and get a handle to it. Spawning does NOT start the actor — it is born idle and will not run until you `send_message` it; spawn and message are separate steps, so spawn now and message when there's work (e.g. spawn a reviewer up front, message it once a PR is ready). Use this to delegate focused or parallel work; the child reports back to you by message. Non-blocking — the child runs asynchronously. Put the FULL scope in the charter — which repo(s) to clone and work in, whether to cut one PR or several — the child clones whatever it needs into its working directory itself.",
      inputSchema: {
        charter: z
          .string()
          .describe(
            "What the new actor owns — its standing brief, authored by you. Include its full scope: the repo(s) to work in (it clones them itself), the deliverable, and whether it should open one PR or several."
          ),
        model_config: modelConfigSchema
          .optional()
          .describe(
            "Provider/model/effort choice(s) for the child, in earliest-available order. A single object pins one choice; pick a different harness/tier than yourself when the work calls for it (e.g. a stronger model for review). An array declares a pool of acceptable choices, tried whichever is earliest-available first — requires context_mode 'ledger' or 'tail', since a native provider session can't move between candidates. Omit to use the standing default coder pool for a portable spawn (context_mode 'ledger' or 'tail'); a native spawn must declare a single model_config entry."
          ),
        conversation_id: z
          .string()
          .optional()
          .describe(
            "Resume an existing provider conversation as the child's session instead of starting fresh. Must belong to the chosen provider's CLI (e.g. an agy conversation id for an 'antigravity' child). The child's charter rides on top of that conversation's accumulated context — use it to promote an existing conversation into an actor (e.g. a context-rich reviewer)."
          ),
        title: z
          .string()
          .optional()
          .describe(
            "A brief one-line description of what this actor is tasked with, shown under its name in the dashboard."
          ),
        context_mode: z
          .enum(CONTEXT_SELECTIONS)
          .optional()
          .describe(
            "Who owns the child's memory between runs. Omit (or 'native') for the default: the provider keeps the session and resumes it. 'ledger' and 'tail' hand ownership to the mesh — the child is called FRESH every run with its own recent history injected into the prompt, so it survives provider quota exhaustion and can be re-mounted on a different harness. 'ledger' keeps a rolling compacted digest plus recent messages and is the one to reach for; 'tail' is a raw window that never compacts. Incompatible with conversation_id."
          ),
      },
    },
    async ({ charter, model_config, conversation_id, title, context_mode }) => {
      try {
        const context = resolveContextSelection(context_mode);
        const modelConfig: ModelConfigInput = model_config ?? [...DEFAULT_CODER_POOL];
        const id =
          selfId === rootId && options?.rootControl
            ? options.rootControl.spawnChild(
                {
                  charter,
                  modelConfig,
                  conversationId: conversation_id,
                  title,
                  context,
                },
                "root-llm"
              )
            : mesh.spawn({
                charter,
                parentId: selfId,
                modelConfig,
                conversationId: conversation_id,
                title,
                context,
              });
        return toolOk({ thread_id: id });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to a thread",
      description:
        "Deliver a message to another actor's inbox (your parent, a child, or a peer you've been introduced to). The recipient wakes and sees that the message came from you, and may reply later as a new message — this is async, never a blocking call.",
      inputSchema: {
        thread_id: z
          .string()
          .describe("The recipient thread id (must be one you hold a handle to)."),
        body: z.string().describe("The message."),
        deliver_at: z
          .string()
          .optional()
          .describe(
            "Absolute ISO-8601 UTC timestamp to schedule future delivery. Self-sends must use this with >=60s delay. Omit for immediate delivery."
          ),
      },
    },
    async ({ thread_id, body, deliver_at }) => {
      try {
        if (isHumanOperator(selfId)) {
          return toolError(
            new Error("actor-facing send path structurally cannot claim human origin")
          );
        }
        if (selfId === rootId && options?.rootControl) {
          options.rootControl.sendMessage(thread_id, body, "root-llm", deliver_at);
          options?.onWrite?.();
          return toolOk(deliver_at ? `scheduled for ${deliver_at}` : "sent");
        }
        const result = mesh.sendMessage(thread_id, body, selfId, undefined, deliver_at);
        if (!result.delivered) {
          if (!result.status) {
            return toolError(new Error(`unknown thread id: ${thread_id}`));
          }
          return toolError(
            new Error(`dropped — recipient ${thread_id} is not live (status: ${result.status})`)
          );
        }
        options?.onWrite?.();
        return toolOk(deliver_at ? `scheduled for ${deliver_at}` : "sent");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_pending_messages",
    {
      title: "List pending scheduled messages",
      description:
        "List all pending messages scheduled for future delivery where you are the sender or the recipient. " +
        "Each carries the stable message_id you pass to cancel_scheduled_message.",
      inputSchema: {},
    },
    async () => {
      try {
        const pending = mesh.listPendingMessagesFor(selfId).map((message) => ({
          message_id: message.messageId,
          recipient: message.recipient,
          sender: message.sender,
          deliver_at: message.deliverAt,
          body: message.body.slice(0, 100) + (message.body.length > 100 ? "..." : ""),
        }));
        return toolOk(pending);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "cancel_scheduled_message",
    {
      title: "Cancel a pending scheduled message",
      description:
        "Cancel a message scheduled for future delivery, before it is delivered. You may cancel a " +
        "message you sent or are receiving, or one involving a descendant of yours. Retirement " +
        "refuses while any scheduled message touches the subtree you're retiring, so this is how " +
        "you clear those blockers — cancel each one, and send a replacement (send_message with " +
        "deliver_at) for whatever still needs to happen. Your decision is recorded against the " +
        "cancelled message.",
      inputSchema: {
        message_id: z
          .string()
          .describe("The stable message id from list_pending_messages or a retirement refusal."),
        reason: z
          .string()
          .optional()
          .describe("Why it no longer applies — kept with the cancellation record."),
      },
    },
    async ({ message_id, reason }) => {
      try {
        const cancelled = mesh.cancelScheduledMessage(message_id, selfId, reason);
        options?.onWrite?.();
        return toolOk({
          cancelled: cancelled.messageId,
          sender: cancelled.fromId,
          recipient: cancelled.toId,
          deliver_at: cancelled.deliverAt,
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "yield_run",
    {
      title: "Yield your turn (done or blocked)",
      description:
        "Release your turn. Call this ONLY when you have no next step you could take yourself right now — either your current objective is complete, or you're blocked waiting on someone else (a review, a reply, an external event). Until you call it, the system keeps waking you to keep making progress, so do NOT yield while a next step is still in your own hands (e.g. you committed but haven't pushed/opened the PR yet — push and open it first). You'll wake again whenever you receive a message or a relevant event. Yielding automatically notifies your parent only when this run was triggered by your parent; externally-triggered clean runs stay silent unless you send_message by judgment. In particular: if you finish work your parent asked you to do during an externally-triggered run (an event or cron woke you, not your parent's message), send_message your parent with the result — the automatic parent notification won't fire for that run. Failed runs still mechanically notify the parent.",
      inputSchema: {
        status: z
          .enum(["complete", "blocked"])
          .describe(
            "'complete' = your current objective is finished; 'blocked' = you can't proceed without someone else."
          ),
        note: z
          .string()
          .optional()
          .describe(
            "Recommended: a one-line summary of what you finished, or what you're blocked on and what would unblock you. For parent-triggered runs, your PARENT receives this; it is always recorded in the mesh log."
          ),
      },
    },
    async ({ status, note }) => {
      try {
        mesh.declareYield(selfId, status, note);
        return toolOk("yielded");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "introduce",
    {
      title: "Introduce one thread to another",
      description:
        "Give `holder_thread_id` a handle to `target_thread_id` so it can message it directly (e.g. let a coder reach a reviewer). Optionally label the target for the holder's purpose; omit `role` to let the holder see the target's own charter.",
      inputSchema: {
        holder_thread_id: z.string().describe("The actor that should gain the new handle."),
        target_thread_id: z.string().describe("The actor the handle points at."),
        role: z
          .string()
          .optional()
          .describe("Optional purpose-specific label for the target, from the holder's view."),
      },
    },
    async ({ holder_thread_id, target_thread_id, role }) => {
      try {
        if (!mesh.actors.get(holder_thread_id)) {
          return toolError(new Error(`unknown thread id: ${holder_thread_id}`));
        }
        if (!mesh.actors.get(target_thread_id)) {
          return toolError(new Error(`unknown thread id: ${target_thread_id}`));
        }
        mesh.grantHandle(holder_thread_id, { id: target_thread_id, role });
        return toolOk("introduced");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_threads",
    {
      title: "List your direct reports",
      description:
        "List the child threads you've spawned, with their charter summary, status, and " +
        "whether each one has a run in flight right now — your org chart for deciding what " +
        "to follow up on or retire. A child whose run_state is 'running', 'winding_down', or 'queued' is " +
        "mid-work: retiring it would abandon that run, and the attempt will be refused.",
      inputSchema: {},
    },
    async () => {
      try {
        // `run_state` is here because its absence is half of what caused ISSUE_NUM: a parent
        // deciding which of two look-alike children to retire could see their charters
        // and their status, but nothing that distinguished a thread mid-build from an
        // idle one. The retire refusal is the guard; this is the information that stops
        // the parent forming the intent in the first place.
        const runStates = mesh.listChildRunStates(selfId);
        const children = mesh
          .list()
          .filter((r) => r.parentId === selfId)
          .map((r) => {
            const runState = runStates.get(r.id) ?? "idle";
            const selection = runState === "queued" ? mesh.getSelection(r.id) : undefined;
            return {
              thread_id: r.id,
              charter: summarizeCharter(r.charter),
              status: r.status,
              run_state: runState,
              ...(selection
                ? {
                    selected_provider: selection.provider,
                    selected_lane: selection.lane,
                    selected_model: selection.model,
                    selected_effort: selection.effort,
                    eligible_at: selection.eligibleAt,
                  }
                : {}),
            };
          });
        return toolOk(children);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "retire_thread",
    {
      title: "Retire a thread",
      description:
        "Mark a thread (and its whole subtree) done and stop it. You may only retire your " +
        "own descendants — completion is the parent's judgment. Refused while that subtree " +
        "has a run in flight: retiring mid-run abandons the provider call and destroys that " +
        "run's work. A queued run can be cancelled and retired by passing force: true. " +
        "Check run_state in list_threads, or just wait for the thread's yield. " +
        "Also refused while the subtree still owns a live obligation or has a scheduled " +
        "message pending in either direction; the refusal names each one, and nothing is " +
        "retired until you have reassigned or finished those obligations and cancelled " +
        "(cancel_scheduled_message) or re-sent those messages.",
      inputSchema: {
        thread_id: z.string().describe("The descendant thread to retire."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Retire even if the thread or a descendant has a queued run (cancelling the queued run). " +
              "Still refused if any thread in the subtree has an active run in flight, and it does " +
              "not bypass the obligation/message refusal above — that work is disposed of by name, " +
              "never overridden by a flag."
          ),
      },
    },
    async ({ thread_id, force }) => {
      try {
        if (!mesh.actors.get(thread_id)) {
          return toolError(new Error(`unknown thread id: ${thread_id}`));
        }
        if (!mesh.isAncestorOf(selfId, thread_id) || thread_id === selfId) {
          return toolError(new Error("you can only retire your own descendant threads"));
        }
        mesh.retire(thread_id, { forceQueued: force });
        return toolOk("retired");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "delegate_event_source",
    {
      title: "Delegate event source to an actor",
      description:
        "Delegate an event source you currently own to any actor you hold a handle to. Ownership is resolved by most-specific-live-subscriber-wins with parent bubbling.",
      inputSchema: {
        child_thread_id: z.string().describe("The actor thread id to receive events."),
        ...eventResourceInputSchema,
      },
    },
    async ({ child_thread_id, source, kind, org, repo, number, ref, space }) => {
      try {
        const resource = parseEventResource(
          { source, kind, org, repo, number, ref, space },
          "delegation"
        );
        mesh.delegateEventSource(resource, child_thread_id, selfId);
        return toolOk(`delegated ${resourceKey(resource)} to ${child_thread_id}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "reclaim_event_source",
    {
      title: "Reclaim delegated event source",
      description:
        "Reclaim an exact delegated event source back to yourself when you would be its effective owner after that exact delegation is removed.",
      inputSchema: eventResourceInputSchema,
    },
    async ({ source, kind, org, repo, number, ref, space }) => {
      try {
        const resource = parseEventResource(
          { source, kind, org, repo, number, ref, space },
          "reclaim"
        );
        mesh.reclaimEventSource(resource, selfId);
        return toolOk(`reclaimed ${resourceKey(resource)}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── Direct subscriptions ── Distinct from delegation above: subscribing takes
  // no ownership, competes with nobody, and only ever adds the CALLER. An actor
  // may put itself on a source's direct-delivery list without displacing whoever
  // owns it, which is the whole point — several actors watching one repo was
  // previously only expressible by handing ownership around.
  //
  // Self-only by construction (`selfId`, not an argument): a subscription is a
  // claim on your own attention, and letting one actor subscribe another would
  // be a way to push work sideways without a handle or a grant.
  server.registerTool(
    "subscribe_event_source",
    {
      title: "Subscribe yourself to an event source",
      description:
        "Receive events from an event source directly, without owning it. Unlike delegation this takes no ownership away from anyone, many actors may subscribe to one source, and subscribed events never bubble to your parent — you get the source's own events and nothing else. The source must be within this instance's configured event sources.",
      inputSchema: eventResourceInputSchema,
    },
    async ({ source, kind, org, repo, number, ref, space }) => {
      try {
        const resource = parseEventResource(
          { source, kind, org, repo, number, ref, space },
          "subscription"
        );
        mesh.addEventSourceSubscriber(resource, selfId, selfId);
        return toolOk(`subscribed to ${resourceKey(resource)}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "unsubscribe_event_source",
    {
      title: "Unsubscribe yourself from an event source",
      description:
        "Stop receiving direct events from an event source you subscribed to. Does not affect ownership: a source you own keeps delivering to you.",
      inputSchema: eventResourceInputSchema,
    },
    async ({ source, kind, org, repo, number, ref, space }) => {
      try {
        const resource = parseEventResource(
          { source, kind, org, repo, number, ref, space },
          "subscription"
        );
        mesh.removeEventSourceSubscriber(resource, selfId);
        return toolOk(`unsubscribed from ${resourceKey(resource)}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── Capability grants (ISSUE_NUM phase 1a, relaxed for parent-grantable secrets in
  // ISSUE_NUM) ── Registered on EVERY endpoint: root can grant any grantable
  // capability to any actor (as before), and a non-root actor can grant/revoke
  // capabilities in the parent-grantable allow-list (currently
  // 'secret:gemini-api-key' and 'secret:mistral-api-key') to/from its DIRECT
  // children. Authorization is enforced in the mesh (grantCapability/
  // revokeCapability take the grantor into account), with the caller's identity
  // baked into this endpoint — so a grantee
  // still cannot re-grant sideways or upward, and non-secret capabilities stay
  // root-only.
  server.registerTool(
    "grant_capability",
    {
      title: "Grant a capability to an actor",
      description:
        "Grant an allow-listed capability to a specific actor by its thread id. As root you may grant any grantable capability (e.g. 'understanding-write'); as a non-root actor you may grant only parent-grantable secrets (currently 'secret:gemini-api-key' and 'secret:mistral-api-key') and only to your DIRECT children. Granted secret files become readable inside the grantee's sandbox at their well-known $RUSA_HOME/secrets paths; the Mistral grant also exports MISTRAL_API_KEY. Idempotent. Takes effect on a live grantee's next run, or when a retired grantee is next revived. Rejected if the capability isn't grantable or you lack authority over the grantee.",
      inputSchema: {
        actor_id: z.string().describe("The grantee actor's thread id."),
        capability: z
          .string()
          .describe("The grantable capability name, e.g. 'secret:mistral-api-key'."),
      },
    },
    async ({ actor_id, capability }) => {
      try {
        mesh.grantCapability(actor_id, capability, selfId);
        return toolOk(`granted ${capability} to ${actor_id}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "revoke_capability",
    {
      title: "Revoke a capability from an actor",
      description:
        "Revoke a previously-granted capability from an actor by its thread id. As root you may revoke any grant; as a non-root actor you may revoke only parent-grantable secrets (currently 'secret:gemini-api-key' and 'secret:mistral-api-key') and only from your DIRECT children. No-op if the grant isn't active. Takes effect on the actor's next run/(re)construction.",
      inputSchema: {
        actor_id: z.string().describe("The actor's thread id to revoke from."),
        capability: z.string().describe("The capability to revoke."),
      },
    },
    async ({ actor_id, capability }) => {
      try {
        await mesh.revokeCapability(actor_id, capability, selfId);
        return toolOk(`revoked ${capability} from ${actor_id}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "set_actor_model",
    {
      title: "Update an actor's declared model pool in-place",
      description:
        "Replace an existing actor's declared provider/model/effort pool in-place in the actor repository without service restart — " +
        "a full replacement of the pool, not a per-field patch. " +
        "Allowed for the actor's parent, or root for any actor including itself. Takes effect at the end of the actor's current run if one is in flight; otherwise applies at the actor's next dispatch, before that run starts and launches. " +
        "A pool of more than one entry, or a change of provider, is only permitted for portable (ledger/tail) actors. " +
        "Preserves the actor's accumulated context and session history.",
      inputSchema: {
        actor_id: z.string().describe("The actor's id to update."),
        model_config: modelConfigSchema.describe(
          "The full replacement provider/model/effort choice(s), in earliest-available order — replaces the entire current pool."
        ),
      },
    },
    async ({ actor_id, model_config }) => {
      try {
        mesh.setActorModel(actor_id, model_config, selfId);
        return toolOk(`staged modelConfig update for ${actor_id}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  // ── Root-only management tools  ── Gated two ways (defense in depth,
  // like the root-only `update` tool): registered ONLY on root's endpoint, AND
  // each handler re-asserts the caller is root.
  if (selfId === rootId) {
    const assertRoot = () =>
      selfId === rootId ? null : toolError(new Error("only the root may use this tool"));

    server.registerTool(
      "revive_thread",
      {
        title: "Revive a retired thread (root-only)",
        description:
          "Revive a previously-retired thread by its thread id. Root-only. Re-instantiates the actor and marks it active, allowing it to be messaged again. The revived actor is born idle and won't run until sent a message.",
        inputSchema: {
          thread_id: z.string().describe("The retired thread id to revive."),
        },
      },
      async ({ thread_id }) => {
        const denied = assertRoot();
        if (denied) return denied;
        try {
          mesh.reviveThread(thread_id);
          return toolOk(`revived thread ${thread_id}`);
        } catch (err) {
          return toolError(err);
        }
      }
    );

    server.registerTool(
      "set_thread_title",
      {
        title: "Set an actor's display title (root-only)",
        description:
          "Set or replace the parent-authored display title shown under an actor's handle in the dashboard (ISSUE_NUM/ISSUE_NUM). Root-only. Patches the durable thread record and reflects immediately (the dashboard reads the record). Use to backfill titles on actors spawned before titles existed, or to re-title an actor.",
        inputSchema: {
          thread_id: z.string().describe("The actor's thread id."),
          title: z.string().describe("The display title — a brief one-liner."),
        },
      },
      async ({ thread_id, title }) => {
        const denied = assertRoot();
        if (denied) return denied;
        try {
          mesh.setThreadTitle(thread_id, title);
          return toolOk(`set title for ${thread_id}`);
        } catch (err) {
          return toolError(err);
        }
      }
    );

    server.registerTool(
      "set_thread_charter",
      {
        title: "Replace an actor's charter (root-only)",
        description:
          "Replace a long-lived actor's charter — its standing brief — on the durable thread record. Root-only. The charter is read fresh and re-injected into the actor's prompt each run, so the new charter takes effect on its next wake. Use to durably re-scope an actor (e.g. promote an elder reviewer to a steward) rather than re-scoping by message alone, which a session reap can lose — the charter is the durable re-derivation anchor. Pass the complete intended charter; it replaces the prior one wholesale.",
        inputSchema: {
          thread_id: z.string().describe("The actor's thread id."),
          charter: z
            .string()
            .describe("The complete new charter; replaces the prior charter wholesale."),
        },
      },
      async ({ thread_id, charter }) => {
        const denied = assertRoot();
        if (denied) return denied;
        try {
          mesh.setThreadCharter(thread_id, charter);
          return toolOk(`set charter for ${thread_id}`);
        } catch (err) {
          return toolError(err);
        }
      }
    );

    server.registerTool(
      "reparent_thread",
      {
        title: "Move an actor to a new parent (root-only)",
        description:
          "Re-parent an actor to a new parent by thread id (e.g. promote a steward and move workers under it so they report to it). Root-only. Changes who receives the actor's completion/yield reports and who may retire it (ownership is the parent edge), and grants the new parent a handle so it can message the actor. The actor's own subtree moves with it. Rejected if it would create a cycle, target the root, or reference an unknown thread.",
        inputSchema: {
          thread_id: z.string().describe("The actor to move."),
          new_parent_id: z.string().describe("The actor that becomes its new parent."),
        },
      },
      async ({ thread_id, new_parent_id }) => {
        const denied = assertRoot();
        if (denied) return denied;
        try {
          mesh.reparentThread(thread_id, new_parent_id);
          return toolOk(`reparented ${thread_id} under ${new_parent_id}`);
        } catch (err) {
          return toolError(err);
        }
      }
    );

    server.registerTool(
      "list_grants",
      {
        title: "List capability grants (root-only)",
        description:
          "List every capability grant (active and revoked) — the audit/inspection view of who holds what.",
        inputSchema: {},
      },
      async () => {
        const denied = assertRoot();
        if (denied) return denied;
        try {
          return toolOk(mesh.listGrants());
        } catch (err) {
          return toolError(err);
        }
      }
    );

    server.registerTool(
      "list_subscriptions",
      {
        title: "List event source ownership and subscriptions (root-only)",
        description:
          "List every event source owner (active claims and released tombstones) and every direct subscriber — the audit/inspection view. Root-only.",
        inputSchema: {},
      },
      async () => {
        const denied = assertRoot();
        if (denied) return denied;
        try {
          // Both row classes in one response, under the tool's existing name.
          // They answer one operator question ("who is getting this source's
          // events, and why") and splitting them across two tools would make
          // the ownership half read as the whole answer.
          return toolOk({
            owners: mesh.listSubscriptions(),
            subscribers: mesh.listEventSourceSubscriptions(),
          });
        } catch (err) {
          return toolError(err);
        }
      }
    );

    // ── Nightly wake schedule — ROOT-ONLY (ISSUE_NUM, phase 1c) ──
    // The mechanical nightly trigger backed by the familiar account's own crontab
    // (a cron job pings the loopback /wake endpoint). Root-only like grants; the
    // crontab edits are surgical (one `# mc-wake:<id>` block) + validated.
    if (wakeScheduler) {
      server.registerTool(
        "schedule_wake",
        {
          title: "Schedule a recurring wake for an actor (root-only)",
          description:
            "Install (or replace) a cron schedule that mechanically wakes an actor — e.g. the nightly IU distill or standing ops (bless cut, digest). `cron_expr` is a standard 5-field cron expression (min hour dom mon dow); `reason` is delivered to the actor's inbox as its wake prompt; `priority` ('responsive' or true) marks the wake to ride the responsive lane and bypass provider pacing. Idempotent per actor. Root-only.",
          inputSchema: {
            actor_id: z
              .string()
              .describe(
                "The actor's thread id (or suffixed wake slot, e.g. 'root:daily-bless-cut') to wake."
              ),
            cron_expr: z
              .string()
              .describe("Standard 5-field cron expression, e.g. '0 3 * * *' for 03:00 daily."),
            reason: z
              .string()
              .describe("The wake prompt delivered to the actor's inbox each time it fires."),
            priority: z
              .union([z.enum(["normal", "responsive"]), z.boolean()])
              .optional()
              .describe(
                "Optional scheduling priority. Set to 'responsive' (or true) for standing ops (bless cut, digest) to ride the responsive lane and skip provider pacing."
              ),
          },
        },
        async ({ actor_id, cron_expr, reason, priority }) => {
          const denied = assertRoot();
          if (denied) return denied;
          try {
            const normalizedPriority =
              priority === "responsive" || priority === true ? "responsive" : undefined;
            await wakeScheduler.schedule(actor_id, cron_expr, reason, normalizedPriority);
            return toolOk(`scheduled wake for ${actor_id} at '${cron_expr}'`);
          } catch (err) {
            return toolError(err);
          }
        }
      );

      server.registerTool(
        "cancel_wake",
        {
          title: "Cancel an actor's recurring wake (root-only)",
          description: "Remove an actor's cron wake schedule. No-op if none is set. Root-only.",
          inputSchema: {
            actor_id: z
              .string()
              .describe(
                "The actor's thread id (or suffixed wake slot, e.g. 'root:daily-bless-cut')."
              ),
          },
        },
        async ({ actor_id }) => {
          const denied = assertRoot();
          if (denied) return denied;
          try {
            await wakeScheduler.cancel(actor_id);
            return toolOk(`cancelled wake for ${actor_id}`);
          } catch (err) {
            return toolError(err);
          }
        }
      );

      server.registerTool(
        "list_wakes",
        {
          title: "List scheduled wakes (root-only)",
          description:
            "List every scheduled wake (actor id, cron expression, reason) — the inspection view of the nightly triggers. Root-only.",
          inputSchema: {},
        },
        async () => {
          const denied = assertRoot();
          if (denied) return denied;
          try {
            return toolOk(await wakeScheduler.list());
          } catch (err) {
            return toolError(err);
          }
        }
      );
    }
  }

  return server;
}
