# Live e2e captures for PR #1262 (issue #1260 acceptance amendment)

Headless-browser captures from an end-to-end run of the empty-store first-actor
bootstrap on an isolated instance built at exact amendment head
`0ef6682ef89c56ca89547cb0aeeea28929c2ea55`. The instance ran with a temporary
home, a config without `rootActor` or auth, and the scripted `fake` provider
(no live provider calls). A headless Chromium session drove the served Flutter
web dashboard: the modal form was filled and submitted with real pointer and
keyboard input.

These captures verify the changes requested in Matt's appearance review comment 6745894853:
1. First-actor modal includes the "Execution isolation" control (SegmentedButton)
   offering Unsandboxed (default) and Sandboxed.
2. The intro copy states truthfully that the first actor receives default capability
   grants as the oldest active parentless actor and serves as fallback recipient for
   unrouted root events and dashboard spawns.
3. Both execution isolation choices (Unsandboxed default and Sandboxed selection)
   are verified creating active root-level actors and executing turns.

| File | What it shows |
| --- | --- |
| `live_modal_wide.png` | First-actor modal over Overview page, 1360x840, showing updated intro copy and Unsandboxed default |
| `live_modal_phone.png` | Same modal at 390x844 (phone viewport) |
| `live_modal_filled.png` | Dialog filled with Title, Charter, Model (Unsandboxed default) |
| `live_created_wide.png` | Dashboard right after creating unsandboxed actor: dialog closed, no re-offer |
| `live_modal_sandboxed_filled.png` | Dialog with "Sandboxed" segment selected and form filled |
| `live_created_sandboxed_wide.png` | Dashboard right after creating sandboxed actor |
| `live_post_restart_wide.png` | Overview after a full service restart: loads with no modal |
| `live_post_restart_actors.png` | Actors tree after restart: the created actor (idle) is present |
| `live_post_restart_phone.png` | Post-restart dashboard at 390x844 |

Full per-step results and API/database receipts are in the PR #1262 comment that
references these captures.
