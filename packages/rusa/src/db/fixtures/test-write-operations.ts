import type {
  CreateObligationInput,
  ObligationRepository,
} from "../repositories/obligation-repository.js";
import type { WriteContext, WriteOperationTable } from "../write-worker-runtime.js";

// Write operations for the writer's tests (#1289), run both in-process and in
// a test worker. Production operations arrive with the first converted family.

export interface TestWriteRepos {
  readonly obligations: ObligationRepository;
}

export interface TestEffect {
  readonly kind: "created" | "announced";
  readonly id: string;
}

type Context = WriteContext<TestWriteRepos, TestEffect>;
type Create = Pick<CreateObligationInput, "id" | "title" | "ownerId">;

export class WriteConflictError extends Error {
  override readonly name = "WriteConflictError";
}

/** Create an obligation and emit two effects for it. */
function create({ repos, emit }: Context, input: Create): { id: string } {
  const { id } = repos.obligations.create(input);
  emit({ kind: "created", id });
  emit({ kind: "announced", id });
  return { id };
}

const pause = new Int32Array(new SharedArrayBuffer(4));

export const TEST_WRITE_OPERATIONS = {
  create,
  /** Creates, emits, then throws: the transaction rolls back. */
  fail: (context: Context, input: Create): never => {
    create(context, input);
    throw new WriteConflictError(`${input.title} conflicts`);
  },
  /** Commits, then answers with a function, which cannot cross a thread. */
  uncloneable: (context: Context, input: Create) => ({
    ...create(context, input),
    callback: () => undefined,
  }),
  /** Commits; its second effect carries a function, which cannot cross a thread. */
  uncloneableEffect: ({ repos, emit }: Context, input: Create): { id: string } => {
    const { id } = repos.obligations.create(input);
    emit({ kind: "created", id });
    emit({ kind: "announced", id, callback: () => undefined } as TestEffect);
    return { id };
  },
  /** Holds the writer for `ms` inside its transaction, then creates. Worker only. */
  hold: (context: Context, input: Create & { readonly ms: number }) => {
    Atomics.wait(pause, 0, 0, input.ms);
    return create(context, input);
  },
  /** The worker dies with its transaction open. Worker only. */
  exitInTransaction: (context: Context, input: Create): never => {
    create(context, input);
    process.exit(7);
  },
  /** Creates; the test worker dies after the commit, before answering. Worker only. */
  exitAfterCommit: create,
} satisfies WriteOperationTable<TestWriteRepos, TestEffect>;

export type TestWriteOperations = typeof TEST_WRITE_OPERATIONS;
