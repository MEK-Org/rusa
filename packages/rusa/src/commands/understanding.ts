import { resolveHome } from "../config/index.js";
import { closeDb, initDb } from "../db/index.js";
import { recomputeDistillation } from "../understanding/distill.js";

/**
 * Run the 'understanding recompute' command.
 */
export async function runUnderstandingRecompute(opts: { since?: string }) {
  const mcHome = resolveHome();

  console.log(`Initializing database...`);
  initDb(mcHome);

  try {
    console.log(
      opts.since
        ? `Resetting distillation for inputs created since ${opts.since}...`
        : `Resetting all distillation state...`
    );

    const count = recomputeDistillation(opts.since);

    if (count === 0) {
      console.log(`No raw inputs found to reset.`);
    } else {
      console.log(`✅ Successfully reset ${count} raw input(s).`);
      console.log(`A new distillation task has been queued for immediate processing.`);
    }
  } catch (err) {
    console.error(`❌ Failed to recompute: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    closeDb();
  }
}
