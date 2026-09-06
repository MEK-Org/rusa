import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createActorRuntime } from "./actor-runtime.js";
import { createProvider } from "./configured-provider.js";
import type { FollowerCommand, FollowerEvent } from "./follower-hub.js";
import type { ProviderFactory } from "./protocol.js";

/** Execution half of an instance: many ordinary Actors, one Node process. */
export class FollowerInstance {
  private actors = new Map<string, ReturnType<typeof createActorRuntime>>();
  private stopped = false;

  constructor(
    private readonly home: string,
    private readonly sandbox: boolean,
    private readonly emit: (event: FollowerEvent) => void,
    private readonly providerFactory: ProviderFactory = createProvider
  ) {}

  get actorIds(): string[] {
    return [...this.actors.keys()];
  }

  dispatch({ actorId, message }: FollowerCommand): void {
    if (this.stopped) return;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(actorId)) throw new Error("Invalid actor ID");
    if (message.type !== "init") {
      this.actors.get(actorId)?.dispatch(message);
      return;
    }
    if (this.actors.has(actorId)) throw new Error("Actor already exists on follower");
    const cwd = join(this.home, "workers", actorId);
    mkdirSync(cwd, { recursive: true });
    const actor = createActorRuntime(
      this.providerFactory,
      (event) => this.emit({ actorId, message: event }),
      () => {
        this.actors.delete(actorId);
        this.emit({ actorId, message: { type: "exit", code: 0, signal: null } });
      }
    );
    this.actors.set(actorId, actor);
    actor.dispatch({
      type: "init",
      bootstrap: {
        ...message.bootstrap,
        id: actorId,
        cwd,
        actorOptions: { ...message.bootstrap.actorOptions, addDirs: [], sandbox: this.sandbox },
      },
    });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const actor of [...this.actors.values()]) actor.close();
  }
}
