/**
 * The provider's explicit response is stronger evidence than a rendered usage
 * panel. Keep this deliberately narrow: ordinary auth failures, generic 403s,
 * and rate limits must not manufacture a five-hour quota observation.
 */
export function isKimiFiveHourLimit403(output: string): boolean {
  const normalized = output.toLocaleLowerCase("en-US");
  return (
    /\b403\b/.test(normalized) &&
    /\b(?:5[-\s]?hour|five[-\s]?hour)\s+(?:usage\s+)?limit\b/.test(normalized)
  );
}
