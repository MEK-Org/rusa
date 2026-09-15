# Changelog

## Unreleased

- Removed GitHub polling (`github.ingestionMode`, `github.pollIntervalSeconds`); GitHub events arrive only through the webhook listener, a config that still sets either key fails at load naming the removal, and a legacy `github-poller-state.json` is ignored.
