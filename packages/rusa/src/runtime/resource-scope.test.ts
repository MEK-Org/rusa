import { describe, expect, it, vi } from "vitest";
import { type DisposeFailure, ResourceScope } from "./resource-scope.js";

describe("ResourceScope", () => {
  it("releases resources in reverse acquisition order", async () => {
    const released: string[] = [];
    const scope = new ResourceScope();
    for (const name of ["database", "server", "timer"]) {
      scope.acquire(name, () => {
        released.push(name);
      });
    }

    await scope.close();

    expect(released).toEqual(["timer", "server", "database"]);
  });

  it("awaits each asynchronous disposer before starting the next", async () => {
    const released: string[] = [];
    const scope = new ResourceScope();
    scope.acquire("database", () => {
      released.push("database");
    });
    scope.acquire("probe", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      released.push("probe settled");
    });

    await scope.close();

    expect(released).toEqual(["probe settled", "database"]);
  });

  it("attempts every disposer and reports each failure by resource", async () => {
    const reported: DisposeFailure[] = [];
    const released: string[] = [];
    const scope = new ResourceScope({ onFailure: (failure) => reported.push(failure) });
    scope.acquire("database", () => {
      released.push("database");
    });
    scope.acquire("server", async () => {
      throw new Error("close failed");
    });
    scope.acquire("mesh", () => {
      throw new Error("shutdown failed");
    });
    scope.acquire("timer", () => {
      released.push("timer");
    });

    const failures = await scope.close();

    expect(released).toEqual(["timer", "database"]);
    expect(failures.map((failure) => failure.resource)).toEqual(["mesh", "server"]);
    expect(reported).toEqual(failures);
  });

  it("keeps releasing when the failure reporter itself throws", async () => {
    const released = vi.fn();
    const scope = new ResourceScope({
      onFailure: () => {
        throw new Error("reporter broke");
      },
    });
    scope.acquire("database", released);
    scope.acquire("server", () => {
      throw new Error("close failed");
    });

    await expect(scope.close()).resolves.toHaveLength(1);
    expect(released).toHaveBeenCalledOnce();
  });

  it("uses a reporter attached after construction", async () => {
    const scope = new ResourceScope();
    const reported: string[] = [];
    scope.reportFailuresTo((failure) => reported.push(failure.resource));
    scope.acquire("server", () => {
      throw new Error("close failed");
    });

    await scope.close();

    expect(reported).toEqual(["server"]);
  });

  it("releases each resource once across repeated and concurrent closes", async () => {
    const dispose = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    const scope = new ResourceScope();
    scope.acquire("server", dispose);

    const first = scope.close();
    const second = scope.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await scope.close();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("releases only what a partial acquisition took", async () => {
    const released: string[] = [];
    const scope = new ResourceScope();
    const boot = () => {
      scope.acquire("database", () => {
        released.push("database");
      });
      scope.acquire("mcp server", () => {
        released.push("mcp server");
      });
      throw new Error("port in use");
    };

    expect(boot).toThrow("port in use");
    await scope.close();

    expect(released).toEqual(["mcp server", "database"]);
  });

  it("throws when a resource is acquired after close has begun", async () => {
    const scope = new ResourceScope();
    await scope.close();
    const dispose = vi.fn();

    expect(() => scope.acquire("late timer", dispose)).toThrow(
      "Cannot acquire resource 'late timer' on a ResourceScope that is already closing"
    );
    expect(dispose).not.toHaveBeenCalled();
  });
});
