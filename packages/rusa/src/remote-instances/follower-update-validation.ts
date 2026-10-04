/** A requested commit must be an unambiguous object id, never a short SHA. */
export function isFullCommitSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

/**
 * Accept ordinary remote branch names while refusing revision syntax, options,
 * and path-like ambiguity before the value reaches `git fetch`.
 */
export function isSafeFollowerBranch(value: string): boolean {
  return (
    /^(?!-)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(
      value
    ) && !value.endsWith("/")
  );
}
