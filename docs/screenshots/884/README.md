Matched synthetic failure notices for #884. The before adapter comes from staging
`a06afc8b8cea58fa789688eafa1ccd79c194fef0`; after uses this PR's adapter.
Both receive the same completed assistant JSON event and an external SIGTERM.
The actual `RunResult` passes through `routeRunFailure`, then its note and
forensics are seeded in the existing mechanical inbox payload shape and rendered
by the unchanged `InboxTab` widget. The rendering fixture makes no live requests.
It asserts the actual note is present and no rendering exception occurs.

Wide is 1100 × 800; narrow is 390 × 844, both at pixel ratio 2. Screenshots
show the same source, timestamp and synthetic content. The changed small-failure
notice adds parsed assistant text and the always-present diagnostic label.
Large diagnostic tails can fill the existing last-800-character failure summary,
so these representative small notices intentionally make the changed label visible.
The auth-preservation summary can also change a large auth failure's displayed
notice; these images cover the interrupted-output change, not every failure form.

`manifest.json` records screenshot bytes/hashes and source pins. These screenshots
are review evidence; Matt's personal appearance approval remains required before
merge. No dashboard widget, layout, style, schema or wire contract was edited.
