# meta_coder_dashboard

Flutter web dashboard for `@thkp-eng/rusa`.

This app is built and deployed as part of the main `packages/rusa` npm package.

## Local Development

From repo root:

```bash
cd packages/rusa
pnpm run analyze:dashboard-ui
pnpm run test:dashboard-ui
pnpm run dev:dashboard-ui
```

## Build Integration

The package build uses:

```bash
cd packages/rusa
pnpm run build:dashboard-ui
```

This runs `scripts/build-dashboard-ui.mjs`, which:

1. Builds Flutter web (`flutter build web --release`)
2. Copies `flutter_dashboard/build/web/*` into `dist/dashboard-ui-app/`

The Node dashboard server then serves those files at runtime.

## Current Route Shell

- `/dashboard`
- `/dashboard/issues/:source`

Desktop keeps split-pane issue detail.
Mobile renders issue detail as a separate screen.
