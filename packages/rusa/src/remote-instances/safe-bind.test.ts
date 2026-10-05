import { describe, expect, it } from "vitest";
import { isSafeFollowerBind } from "./safe-bind.js";

describe("isSafeFollowerBind", () => {
  it("accepts loopback 127.0.0.1", () => {
    expect(isSafeFollowerBind("127.0.0.1")).toBe(true);
  });

  it("accepts valid Tailscale CGNAT IPv4 addresses (100.64.0.0/10)", () => {
    expect(isSafeFollowerBind("100.64.0.1")).toBe(true);
    expect(isSafeFollowerBind("100.100.100.100")).toBe(true);
    expect(isSafeFollowerBind("100.127.255.254")).toBe(true);
    expect(isSafeFollowerBind("100.64.0.0")).toBe(true);
    expect(isSafeFollowerBind("100.127.255.255")).toBe(true);
  });

  it("rejects public addresses and wildcards", () => {
    expect(isSafeFollowerBind("0.0.0.0")).toBe(false);
    expect(isSafeFollowerBind("8.8.8.8")).toBe(false);
    expect(isSafeFollowerBind("192.168.1.1")).toBe(false);
    expect(isSafeFollowerBind("10.0.0.1")).toBe(false);
    expect(isSafeFollowerBind("localhost")).toBe(false);
    expect(isSafeFollowerBind("::1")).toBe(false);
  });

  it("rejects out-of-range Tailscale addresses and malformed octets", () => {
    expect(isSafeFollowerBind("100.63.1.1")).toBe(false);
    expect(isSafeFollowerBind("100.128.0.1")).toBe(false);
    expect(isSafeFollowerBind("100.64.999.1")).toBe(false);
    expect(isSafeFollowerBind("100.64.0.256")).toBe(false);
    expect(isSafeFollowerBind("100.64.1")).toBe(false);
  });
});
