const replies = [
  {
    id: 3916478990,
    body: "The provenance for this requirement is Matt's 2026-09-02 11:34:36Z request in the Rusa space (`gchat:spaces/AAQAvOIVSGw/messages/1a1Eidfv9Qk.1a1Eidfv9Qk`), where he explicitly asked for external-artifact content previews without hitting external backends every render and proposed a reference-ID to JSON cache. The PR body has been updated to cite this.\n\n*daring-orangutan*",
  },
  {
    id: 3916479002,
    body: "Good catch. I've updated the `ReferenceCacheService` to wrap the repository `get` and `set` calls in `try/catch` blocks. Now, cache-layer faults degrade to a generic unavailable miss per reference, ensuring that one faulty cache read doesn't reject the entire `Promise.all` response. I also added a test to prove this fault isolation.\n\n*daring-orangutan*",
  },
  {
    id: 3916479004,
    body: "Done. I updated the V1 decoder validation to also ensure the discriminator matches the expected provider shape derived from the reference scheme. A structurally valid entity with the wrong discriminator is now correctly treated as an unavailable cold miss, and a corruption test has been added to cover this.\n\n*daring-orangutan*",
  },
  {
    id: 3916479012,
    body: "Done. The dashboard now resolves inbox mesh references synchronously through `resolveReferenceSync` and no longer passes them through the asynchronous cache service routing, keeping the existing fast path intact.\n\n*daring-orangutan*",
  },
  {
    id: 3916479023,
    body: "Agreed, there is no current reader for the `refresh_after` index in V1 since eviction and scanning are deferred. I have removed the secondary index from the migration schema to avoid the write cost until a sweeper is implemented.\n\n*daring-orangutan*",
  },
  {
    id: 3916479034,
    body: "Done. I've updated the deadline test to use a controllable promise for the provider read. It now asserts the `pending` state initially, resolves the promise, and then ticks the event loop to prove that the background write still successfully persists to the cache repository.\n\n*daring-orangutan*",
  },
  {
    id: 3916479044,
    body: "Done. I've added a route-level test to `api.test.ts` that mocks `referenceCache` to simulate a successful external cache hit alongside a simulated cache exception. It proves that the external cache state and entity are embedded correctly in the API response and that a failing artifact isolates its fault without erasing its siblings.\n\n*daring-orangutan*",
  },
  {
    id: 3916501576,
    body: "Done. I have restored the tolerant parsing in the Dart models (`as String? ?? ''`) for these reference fields, backing out the unintended strictness flip so we don't unexpectedly throw mid-page on contract drift.\n\n*daring-orangutan*",
  },
  {
    id: 3916501589,
    body: "Agreed, this index has no consumer in V1 since background sweeps were deferred. I've removed `idx_reference_cache_refresh` from the migration for now; we can add it back when the consumer lands.\n\n*daring-orangutan*",
  },
  {
    id: 3916501601,
    body: "Done. I added a symmetric `if (found)` guard to the `getMessage` branch in `cache-service.ts` for clarity, matching the `getSpace` check above.\n\n*daring-orangutan*",
  },
  {
    id: 3916501607,
    body: "Yes, this is a conscious deferral for V1. We want to preserve the full cached document without early truncation in the backend, while keeping the default collapsed view bounded. The pathological edge case of an extremely large expanded view is accepted for this milestone and will be addressed in a follow-up.\n\n*daring-orangutan*",
  },
];
fs.writeFileSync("replies.json", JSON.stringify(replies));
