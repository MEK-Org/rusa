declare const __RUSA_BUILD_ID__: string | undefined;

/**
 * The tsup run that built this code, compiled in by `define` (tsup.config.ts),
 * so it names the code that is running rather than whatever `dist` holds by
 * the time someone looks. Null from source. The read pool refuses a worker
 * whose id differs from its own (#1289).
 */
export const BUILD_ID: string | null =
  typeof __RUSA_BUILD_ID__ === "string" ? __RUSA_BUILD_ID__ : null;
