# Shared multi-user authentication — draft, not ready for review

This slice is stacked above #436 (durable request identities) and #434 (optional
Firebase authentication). It follows the operator's explicit clarification:
every admitted human can see and do everything in v1. Older actor-authored
tenant-isolation proposals are not the product specification.

## Implemented model

- `auth.email` remains supported; `auth.allowedEmails` admits multiple Google
  accounts instead. Exactly one admission setting is required when auth is enabled.
- Each verified Firebase identity has its own durable principal. Every admitted,
  enabled principal receives shared operator authority over the existing mesh.
- No human needs a root association. Multiple humans can share the same root.
  There is no first-user administrator distinction or per-user visibility filter.
- Authentication, signed double-submit CSRF, five-day rolling sessions, stream
  inactivity handling, and per-user disablement remain enforced.
- Existing action attribution remains `human:operator`. Distinct durable request
  identities do not yet imply per-human attribution throughout stored history.
- The earlier unwired `TenantAuthorization` helper and tests have been removed;
  they encoded restrictions contrary to this clarified v1 policy. Git history
  preserves them, but they are not a prerequisite for shared access.

## Independent follow-up work

**Root cardinality:** relax the single-root constraint generally, without
requiring a root for each human. This involves the `actors_single_root_idx`
schema constraint, configured/default root assumptions in ActorMesh, root-control
selection, and runtime lifecycle tests. This PR does not remove that constraint.
Existing structural/action invariants still apply equally to every human.

**Event-source ownership:** a source such as a Christina DM can be associated
with Christina's email even if she has never logged in. Ownership metadata must
be independent of login provisioning, root count, and access restrictions. The
exact source-owner representation and explicit identity-binding workflow remain
to be designed. This PR neither provisions source owners nor implicitly claims
an existing pending principal by matching email at login.

**Attribution:** future work can retain the initiating human's durable ID in
events/actions while preserving historical `human:operator` records. No historical
rewrite or human-to-root migration is performed here.

The default remains unauthenticated when auth is omitted. Enabling shared auth
does not mean open registration: anonymous and non-allowlisted users remain denied.
