This is a repository for orchestrating AI agents to build software.

## Development & Verification Guidelines

- **Install dependencies cleanly.** Run `pnpm install` across workspace projects.
- **Validate with project quality gates.** Before submitting pull requests, ensure the following checks pass:
  - `pnpm lint` (or `pnpm format` to automatically apply Biome rules)
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm --filter rusa run analyze:dashboard-ui` and `pnpm --filter rusa run test:dashboard-ui` (when modifying the Flutter dashboard)
  - `pnpm build`
- **State validation commands in PR descriptions.** Include the exact commands run and verification outcomes.
- **Diff hygiene.** Keep pull requests concise, targeted, and focused only on the task at hand. Avoid unnecessary diff churn across unrelated files.
- **Log through the application logger.** Diagnostics go through the structured
  logger, not `console.*`; read [docs/logging.md](docs/logging.md) before adding
  one. A mechanical gate rejects new direct `console.*` diagnostics outside the
  reviewed CLI-output allowlist.

## Referencing prior work

This repository is public, and its issue numbers are its own. A reference that
resolves somewhere else is worse than no reference: `#123` autolinks against
*this* repository the moment the line is quoted into a comment, a commit message
or a PR body, and lands on whatever happens to occupy that number here.

- **Don't cite issues from other repositories** — neither bare (`#1234`) nor
  qualified (`some-org/some-repo#1234`). Qualifying stops the mis-link, but does
  it by publishing where the work came from, which is the other half of the
  problem.
- **Inline the reasoning instead.** A citation is a pointer to a finding, and the
  finding can simply be stated. `// Refs some-repo#1234` becomes a sentence
  saying what was learned and why the code is shaped this way — which is more
  useful to the next reader anyway, since they can't open the issue.
- **Paraphrase; don't quote, and don't name people.** State the conclusion in the
  code's own voice. "Fetch quota once on load; it refreshes infrequently" carries
  the entire decision without reproducing anyone's words or attributing them.
- **This repository's own issues are fine bare** (`#63`, `#112`). They resolve
  correctly now and will keep resolving correctly.
- **`ISSUE_NUM` is an elided foreign reference,** not a real number — it marks
  where one used to be. When you touch such a line, replace the placeholder with
  the reasoning rather than with a number.

## GitHub username mentions

This repository is public, so an `@username` notifies a real GitHub account. Use
the `@` sigil only when the username is explicitly known to belong to this
project. The complete known set is `AlabasterAxe`, `CodeChopsBot`, and
`SiliconFamiliar` (and mentioning `SiliconFamiliar` is usually unnecessary).

For every other person or actor, write the name without `@`. A plausible handle
is not evidence that the matching GitHub account is the intended recipient.
