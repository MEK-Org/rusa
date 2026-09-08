/**
 * Bind address safety predicate for follower gateway.
 *
 * Enforces #301 gateway security constraint:
 * Bind address must be an explicit loopback (127.0.0.1) or Tailscale CGNAT
 * IPv4 address (100.64.0.0/10: 100.64.0.0 to 100.127.255.255).
 * Refuses wildcards (0.0.0.0) and public addresses.
 */

const TAILSCALE_IPV4_REGEX =
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function isSafeFollowerBind(host: string): boolean {
  return host === "127.0.0.1" || TAILSCALE_IPV4_REGEX.test(host);
}
