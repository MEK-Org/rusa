import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import type { UserPrincipal } from "../principals/principal-ref.js";
import { humanChatScope } from "./human-chat-scope.js";
import {
  canReadRunPrompt,
  parseRunPromptProvenance,
  type RunPromptProvenance,
} from "./run-prompt-visibility.js";

const privateLedger: RunPromptProvenance = {
  version: 1,
  complete: true,
  sources: [
    { id: "fixture-scaffold", classification: "shared" },
    {
      id: "fixture-inherited-ledger-source",
      classification: "human_chat",
      participants: [
        { id: "bob", kind: "user" },
        { id: "actor", kind: "actor" },
      ],
    },
  ],
};
const alice: UserPrincipal = {
  kind: "user",
  id: "alice",
  email: "alice@example.com",
  createdAt: "2026-01-01T00:00:00Z",
};
const req = {} as IncomingMessage;

describe("#866 frozen prompt requirements and current scope", () => {
  it("withholds unknown/incomplete/unsupported provenance as a whole", () => {
    const scope = humanChatScope(req, [alice]);
    for (const doc of [
      null,
      { version: 1, complete: false, sources: [] },
      { version: 1, complete: true, sources: [{ id: "ledger", classification: "unknown" }] },
    ]) {
      expect(canReadRunPrompt(parseRunPromptProvenance(doc), scope)).toBe(false);
    }
  });
  it("allows complete positively shared actor-only provenance", () => {
    const shared = parseRunPromptProvenance({
      version: 1,
      complete: true,
      sources: [{ id: "fixture-scaffold-charter-and-actor-context", classification: "shared" }],
    });
    expect(canReadRunPrompt(shared, humanChatScope(req, [alice]))).toBe(true);
  });
  it("does not turn private ledger/inherited input shared after user/history deletion or reclassification", () => {
    const bob: UserPrincipal = {
      kind: "user",
      id: "bob",
      email: "bob@example.com",
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(canReadRunPrompt(privateLedger, humanChatScope(req, [alice, bob]))).toBe(false);
    // Bob no longer appears in listUsers; ordinary current canSee now treats his id as shared.
    const scope = humanChatScope(req, [alice]);
    expect(scope.canSee("bob", "actor")).toBe(true);
    expect(canReadRunPrompt(privateLedger, scope)).toBe(false);
    // No history query is made during authorization: deleted events cannot rewrite the receipt.
    expect(privateLedger.sources[1]).toMatchObject({ classification: "human_chat" });
  });
  it("evaluates current canSee/group requirements and current revocation instead of cached viewer IDs", () => {
    let permitted = true;
    const scope = {
      viewerIds: new Set(["bob"]),
      canSee: (...ids: string[]) => permitted && ids.includes("bob") && ids.includes("actor"),
    };
    expect(canReadRunPrompt(privateLedger, scope)).toBe(true);
    permitted = false;
    expect(canReadRunPrompt(privateLedger, scope)).toBe(false);
  });
});
