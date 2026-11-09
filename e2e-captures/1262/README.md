# Live e2e captures for PR #1262 (issue #1260 acceptance)

Headless-browser captures from an end-to-end run of the empty-store first-actor
bootstrap on an isolated instance built at exact head
`da35b6dec620d669b05a547591181b54ecaa9bb5`. The instance ran with a temporary
home, a config without `rootActor` or auth, and the scripted `fake` provider
(no live provider calls). A headless Chromium session drove the served Flutter
web dashboard: the modal form was filled and submitted with real pointer and
keyboard input.

| File | What it shows |
| --- | --- |
| `live_modal_wide.png` | First-actor modal over the Overview page, 1360x840, empty store |
| `live_modal_phone.png` | Same modal at 390x844 |
| `live_modal_filled.png` | The dialog with Title, Charter and Model filled, Provider `fake` |
| `live_created_wide.png` | Dashboard right after Create: dialog closed, no re-offer |
| `live_post_restart_wide.png` | Overview after a full service restart: loads with no modal |
| `live_post_restart_actors.png` | Actors tree after restart: the created actor (idle) is present |
| `live_post_restart_phone.png` | Post-restart dashboard at 390x844 |

Full per-step results and API/log evidence are in the PR #1262 comment that
references these captures.
