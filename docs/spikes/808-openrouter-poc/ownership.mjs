import { readdir, readFile, readlink } from "node:fs/promises";

// Linux-only ownership proof. A successful HTTP response alone is insufficient:
// require both listening sockets to belong to the spawned child or descendants.
export async function assertOwnedListeners(childPid, ports) {
  if (process.platform !== "linux") throw new Error("Smoke ownership check requires Linux procfs");
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const parents = new Map();
  for (const pid of pids) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      parents.set(Number(pid), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      /* exited */
    }
  }
  const owned = (pid) => {
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (pid === childPid) return true;
      seen.add(pid);
      pid = parents.get(pid);
    }
    return false;
  };
  const inodes = new Set();
  for (const pid of pids.filter((value) => owned(Number(value)))) {
    try {
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        try {
          inodes.add(await readlink(`/proc/${pid}/fd/${fd}`));
        } catch {
          /* closed */
        }
      }
    } catch {
      /* exited */
    }
  }
  const rows = (
    await Promise.all(["tcp", "tcp6"].map((table) => readFile(`/proc/net/${table}`, "utf8")))
  ).flatMap((table) =>
    table
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
  );
  for (const port of ports) {
    const listeners = rows.filter(
      (row) => row[3] === "0A" && Number.parseInt(row[1].split(":")[1], 16) === port
    );
    if (!listeners.length || listeners.some((row) => !inodes.has(`socket:[${row[9]}]`))) {
      throw new Error(`Port ${port} is not exclusively owned by the spawned instance`);
    }
  }
}
