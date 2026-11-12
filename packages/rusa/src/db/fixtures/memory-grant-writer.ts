import {
  MESH_WRITE_OPERATIONS,
  type MeshObligationWriter,
  type MeshWriteRepos,
} from "../mesh-write-operations.js";

/** The stores the grant and experiment write operations read and change. */
export type GrantWriteRepos = Pick<MeshWriteRepos, "actors" | "grants" | "experiments">;

const GRANT_WRITE_OPERATIONS = new Set<string>([
  "grants.grant",
  "grants.revoke",
  "grants.setOperatorProvisioned",
  "experiments.enroll",
  "experiments.unenroll",
]);

/** True if `op` is a grant or experiment write {@link runGrantWrite} makes. */
export function isGrantWrite(op: string): boolean {
  return GRANT_WRITE_OPERATIONS.has(op);
}

/**
 * Run one grant or experiment write operation over in-memory stores, for a
 * test mesh with no database (#1289 D1). The production operation decides it,
 * so the authority a test exercises is the writer's. These operations emit no
 * effects; the production writer's transaction and rollback are tested over
 * SQLite.
 */
export async function runGrantWrite(
  repos: GrantWriteRepos,
  op: string,
  input: unknown
): Promise<unknown> {
  if (!isGrantWrite(op)) throw new Error(`not a grant write: ${op}`);
  const operation = MESH_WRITE_OPERATIONS[op as keyof typeof MESH_WRITE_OPERATIONS] as (
    context: unknown,
    input: unknown
  ) => unknown;
  return operation(
    {
      repos,
      emit: () => {
        throw new Error(`${op} emitted an effect a grant write does not make`);
      },
      afterCommit: (callback: () => void) => callback(),
    },
    input
  );
}

/** A writer over in-memory stores that makes only grant and experiment writes. */
export function memoryGrantWriter(repos: GrantWriteRepos): Pick<MeshObligationWriter, "write"> {
  const write = (op: string, input: unknown) => runGrantWrite(repos, op, input);
  return { write } as Pick<MeshObligationWriter, "write">;
}
