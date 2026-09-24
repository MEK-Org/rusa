#!/usr/bin/env node
import { runCoordinatorPathCheck } from "../build/maintenance/commands/coordinator-path-check.js";

function usage() {
  return [
    "Usage:",
    "  pnpm --filter rusa run check:coordinator-path [--home <path>]",
    "",
    "Non-fatal diagnostic comparing installed quota coordinator unit PATH against instance unit PATH.",
    "",
    "Options:",
    "  --home <path>  Rusa home to read configured provider CLIs from (default: $RUSA_HOME).",
    "  --help, -h     Show this help message.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--home" && argv[i + 1]) {
      options.home = argv[++i];
    } else if (arg.startsWith("--home=")) {
      options.home = arg.slice("--home=".length);
    }
  }
  return options;
}

const options = parseArgs(process.argv);
runCoordinatorPathCheck(options);
