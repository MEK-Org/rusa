# Quick Start Guide

This guide describes how to run and configure a local, containerized instance of Rusa using the quickstart workflow. 

---

## 1. Quickstart Usage

The `rusa quickstart` command provides a fully automated way to build and boot a local Docker container for evaluating Rusa. Under the hood, this workflow builds a local image, provisions a persistent Docker volume, sets up a temporary configuration container, guides you through a setup wizard, and then launches the main orchestrator container.

### Command Options
The root `quickstart` command accepts the following options:

* `--image <name>`: The Docker image tag to build or run (default: `rusa:quickstart`).
* `--container <name>`: The name of the launched application container (default: `rusa-quickstart`).
* `--volume <name>`: The Docker volume used to persist the service user's home and Rusa data (default: `rusa-quickstart-home`).
* `--no-build`: Skip the local Docker image build step and run an existing local image.
* `--repo <path>`, `--local-repo <path>`: Local Git repository directory to evaluate with Rusa. If omitted in an interactive terminal, quickstart prompts for it.

### Walkthrough: End-to-End Flow

1. **Host-Side Local Repository Validation**
   Before launching any container, `rusa quickstart` prompts for or accepts `--repo <path>` and validates it on the host:
   * Confirms the path exists and is a directory.
   * Confirms the path is inside a Git worktree (`git rev-parse --is-inside-work-tree`).
   * Confirms the repository has at least one commit (`git rev-parse --verify HEAD`).

2. **Image Build & Volume Provisioning**
   Unless `--no-build` is specified, the CLI builds the local Docker image `rusa:quickstart`. It then creates a persistent Docker volume (`rusa-quickstart-home` by default) to hold your credentials, repository checkouts, and configuration files.

3. **Temporary Setup Container & Configuration Wizard**
   A temporary container named `<container>-setup` is started in the background, mounting the persistent volume at `/home/node`. The CLI guides you through the configuration wizard:
   * **Coding LLM providers**: Choose one or more of `codex`, `claude`, `antigravity`, or `kimi` (defaults to `codex`).
   * **Provider sign-in**: For `codex`, `claude`, and `antigravity`, quickstart hands the real terminal to that vendor's CLI login, then verifies the login before continuing (for `antigravity`, exit the CLI session via `Ctrl+D Ctrl+D` or `/exit` after logging in to proceed). No API key is pasted into Rusa. Quickstart login for `kimi` is not supported yet; complete authentication with the vendor's own CLI.
   * **Verification record**: Quickstart writes each supported provider's pass/fail verification result and exit code to `$RUSA_HOME/logs/quickstart-provider-login.jsonl`; it never captures vendor login output.
   * **Gemini API key**: Used for background classification and avatar tasks and written to the Rusa secrets directory.
   * **Root handle**: The display identity for the local root actor.

4. **Automatic Repository Subscription**
   Quickstart writes or updates `github.repos` in the volume's `config.yaml` with `local/<dirname>`. On reconfigure, it updates any existing `local/*` entry without duplicates, preserving other configured repositories.

5. **Launching the Orchestrator & Local Git Remote Setup**
   Once configuration is complete, the quickstart CLI tears down the setup container and boots the main app container (`rusa-quickstart`).
   After the container starts:
   * Quickstart polls the local Git bridge port (`8085`) on loopback until it accepts connections (up to 15s).
   * It configures the Git remote on your local repo (`git remote add rusa http://localhost:8085/local/<dirname>.git` or `set-url` if the remote already exists).
   * It seeds the repository to Rusa by pushing `HEAD` (`git push rusa HEAD`).
   * If the bridge wait times out or the push fails, fallback commands are printed so you can manually push.

### Local Repository, Not GitHub
Quickstart is built to run against a **local repository** through the Git bridge below; it does not talk to GitHub. The wizard writes a webhook stanza (the only GitHub ingestion edge) but subscribes to no external repositories: the orchestrator binds the webhook listener inside the container, but the port is not published and no external repository is admitted.

### Local Git Bridge
The Git bridge publishes a local web dashboard on port `8080` and the smart HTTP Git server on port `8085`.
When quickstart configures your repository, you can interact with the bridge using standard Git commands from your repository directory:

Fetch branches produced by agents:
```bash
git fetch rusa
```
Push updates to the orchestrator:
```bash
git push rusa HEAD
```
If you need to manually configure or re-seed the remote:
```bash
git remote add rusa http://localhost:8085/local/<dirname>.git
git push rusa HEAD
```

---

## 2. Credential Model & Secrets

Rusa quickstart persists the service user's home directory in the Docker volume (`/home/node`). This lets provider CLIs write their own interactive-login state where the subsequent service container reads it, while keeping it out of the host home directory and process list.

### Written Configuration Files
During the `quickstart configure` step, the following files are written under `$RUSA_HOME` in the volume with restrictively locked permissions (`0o600` file permissions and parent directories with `0o700`):
* `config.yaml`: The main configuration file containing GitHub subscriptions, accounts, and provider mappings.
* `secrets/gemini-api-key`: Holds the Gemini API key collected by the wizard.

### GitHub Token Resolution Order
When the GitHub client needs to authenticate API requests, it resolves the token in the following order:
1. **Environment Variables**: `GH_TOKEN` or `GITHUB_TOKEN` (takes precedence).
2. **Secret File**: `$RUSA_HOME/github-token` (defaults to `~/.rusa/github-token`).
3. **CLI Token**: Runs the CLI credential helper `gh auth token` command.

### Optional GitHub PAT
Providing a GitHub PAT is **optional for the local Git bridge itself**. Tracker operations against GitHub (issues, pull requests, comments) require a credential through one of the resolution paths above.

### Worker-Sandbox GitHub Credential Split (`github.workerTokenPath`)

By default, every sandboxed worker actor sees the **same** GitHub credential the host plane uses (whatever `gh auth token` / `$RUSA_HOME/github-token` / `GH_TOKEN` resolves to) — including a full-`repo`-scope classic token if that's what you've authenticated `gh` with. That means any worker can write anything to GitHub the host account can.

Setting `github.workerTokenPath` narrows this: sandboxed workers are handed a **read-mostly, fine-grained PAT** instead, while the host plane (root actor, `tracker` MCP) keeps using its own, more privileged credential.

```yaml
github:
  account: your-github-account
  workerTokenPath: /home/svc/.rusa/worker-github-token
```

**Minting the PAT** (GitHub → Settings → Developer settings → Fine-grained tokens):
* **Resource owner**: the org (or account) that owns your target repos.
* **Repository access**: the repos your workers operate on.
* **Permissions**:
  * Contents: **Read and write** (required for `git push` via `gh auth git-credential`).
  * Issues: Read-only
  * Pull requests: Read-only
  * Actions: Read-only
  * Commit statuses: Read-only
  * Workflows: **No access**

**Two consequences of this permission set, verified empirically (2026-07-16):**

* **`gh pr checks` does not work with the worker token.** The Checks API is a
  GitHub-App-only permission — fine-grained PATs cannot be granted it, so
  `statusCheckRollup` (which `gh pr checks` reads) returns "Resource not
  accessible". Workers read CI through the **Actions API** instead, which
  carries the same per-job status/conclusion:
  ```bash
  gh run list -R <owner/repo> --commit <sha>
  gh api repos/<owner/repo>/actions/runs?head_sha=<sha> --jq '.workflow_runs[] | "\(.name): \(.status) \(.conclusion)"'
  gh api repos/<owner/repo>/actions/runs/<id>/jobs --jq '.jobs[] | "\(.name): \(.status) \(.conclusion)"'
  ```
* **A worker can still merge PRs into unprotected branches.** GitHub gates
  `PUT /pulls/{n}/merge` on *Contents: write* (a merge writes contents), which
  the token must have for `git push`. Accepted residual: merge events are
  bodiless and flow through the normal event rules; protected branches (e.g. a
  review-required ruleset on `master`) remain protected regardless of token.
  Routing `git push` through an MCP broker (removing Contents: write) is the
  eventual fix if this residual stops being acceptable.

**Operator install steps:**
1. Mint the PAT above and copy its value.
2. Write it to a file on the host, e.g.:
   ```bash
   echo -n "github_pat_..." > /home/svc/.rusa/worker-github-token
   chmod 600 /home/svc/.rusa/worker-github-token
   ```
3. Add `github.workerTokenPath` (pointing at that file) to `config.yaml`.
4. Restart the rusa service.

The flip is **inert until both steps 2 and 3 are done** — the config key with no file, or a file with no config key, changes nothing.

**Behavior:**
* **Key unset (default)**: identical to today — every sandboxed worker sees the host's real `~/.config/gh`. The service logs a one-line warning at the first sandboxed spawn so this exposure stays visible in the logs.
* **Key set, file present**: sandboxed workers' `~/.config/gh` is replaced with a synthesized config carrying only the scoped PAT; `GH_TOKEN`/`GITHUB_TOKEN` are cleared inside the sandbox so they can't override it; and the host's own write-capable token file is hidden from the sandbox's read scope.
* **Key set, file missing**: sandboxed workers **refuse to spawn** — this is deliberately fail-closed, the same way a missing required credential stops boot, rather than silently falling back to the host's write-capable token, which would defeat the point of the split.
* This only affects **sandboxed worker actors**. The root actor always runs unsandboxed on the host plane and keeps using the host's own GitHub credential regardless of this setting.

---

## 3. Sandboxing & Isolation

When running the Quickstart path, you must understand the design boundaries and security posture of the containerized environment:

> [!WARNING]
> **Quickstart workers are NOT isolated from one another.**  
> Shape B runs workers unsandboxed inside the container; Docker namespaces are the *only* boundary. Workers share the container filesystem and can trample each other.

> [!IMPORTANT]
> **Quickstart is container-only.**  
> There is no per-worker sandbox (no bubblewrap/`bwrap` is active in the quickstart Docker image). For worker-to-worker isolation, you must **graduate to a sandboxed VM (Shape C)**.

> [!CAUTION]
> **Bare-host security warning.**  
> The containerized quickstart path publishes the dashboard and git-bridge **loopback-bound** (`127.0.0.1:8080` / `:8085`) so they are not LAN-exposed by construction. However, a **bare-host hand-run** (`pnpm start` directly, skipping the container) binds to `0.0.0.0` and exposes an **unauthenticated** dashboard + git-bridge on your local network. Users are strongly steered to use the containerized path.

---

## 4. Graduation Path

The Quickstart profile is designed for easy, zero-setup local evaluation of Rusa:

* **Quickstart (Shape B)**: Runs all worker agents inside a single Docker container. This is simple to boot but does not enforce isolation between tasks. It is ideal for local, single-repo trials.
* **VM-Sandboxed (Shape C)**: For production deployments, multi-repo tracking, and concurrent multi-tenant execution, you should graduate to Shape C. Here the **VM is the containment boundary**; within it, workers additionally run under per-worker bubblewrap (`bwrap`) sandboxes as a guardrail against accidental cross-worker interference. (bwrap is a guardrail against misbehaving-but-not-malicious actors, not a hard security boundary — the VM provides the actual isolation.)
