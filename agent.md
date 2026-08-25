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

