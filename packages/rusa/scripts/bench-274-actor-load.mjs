import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

function wholeNumber(name, fallback, minimum = 1) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < minimum || !Number.isSafeInteger(Number(value))) {
    throw new Error(
      `${name} must be a safe integer >= ${minimum}; received ${JSON.stringify(value)}`
    );
  }
  return Number(value);
}

const actorCount = wholeNumber("ACTORS", 1000);
const messagesPerActor = wholeNumber("MESSAGES_PER_ACTOR", 100);
const humanMessagesPerActor = wholeNumber("HUMAN_MESSAGES_PER_ACTOR", 20, 0);
const sweeps = wholeNumber("SWEEPS", 3);
if (humanMessagesPerActor > messagesPerActor) {
  throw new Error("HUMAN_MESSAGES_PER_ACTOR cannot exceed MESSAGES_PER_ACTOR");
}

const newestInbound = `
  SELECT session_id FROM mesh_chat
  WHERE recipient_id = ? AND sender_id = ?
  ORDER BY ts DESC, id DESC LIMIT 1
`;

// The correction used by #293: make one query for every historical human
// message and keep the first row per recipient in JS. It preserves the newest
// message tie break but materializes every matching row, rather than one row
// per actor.
const batchedNewestInbound = `
  SELECT recipient_id, session_id FROM mesh_chat
  WHERE sender_id = ?
  ORDER BY recipient_id, ts DESC, id DESC
`;

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE mesh_chat (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    body TEXT NOT NULL,
    session_id TEXT
  );
`);

const insert = db.prepare(
  "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?,?,?,?,?,?)"
);
db.transaction(() => {
  for (let actor = 0; actor < actorCount; actor++) {
    const recipient = `actor-${actor}`;
    for (let message = 0; message < messagesPerActor; message++) {
      const ordinal = actor * messagesPerActor + message;
      insert.run(
        `chat-${ordinal}`,
        new Date(ordinal * 1000).toISOString(),
        message < humanMessagesPerActor ? "human:operator" : `peer-${message % 10}`,
        recipient,
        "synthetic",
        `session-${ordinal}`
      );
    }
  }
})();
db.exec("ANALYZE");

function plan(sql, params) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

function measurePerActor() {
  const query = db.prepare(newestInbound);
  const runs = [];
  let matchedActors = 0;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const startedAt = performance.now();
    for (let actor = 0; actor < actorCount; actor++) {
      if (query.get(`actor-${actor}`, "human:operator")) matchedActors++;
    }
    runs.push(performance.now() - startedAt);
  }
  return { milliseconds: runs, matchedActors };
}

function measureBatched() {
  const query = db.prepare(batchedNewestInbound);
  const runs = [];
  let matchedActors = 0;
  let materializedRows = 0;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const startedAt = performance.now();
    const newestByRecipient = new Set();
    const rows = query.all("human:operator");
    for (const row of rows) newestByRecipient.add(row.recipient_id);
    runs.push(performance.now() - startedAt);
    matchedActors += newestByRecipient.size;
    materializedRows += rows.length;
  }
  return { milliseconds: runs, matchedActors, materializedRows };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const perActorUnindexed = {
  plan: plan(newestInbound, ["actor-0", "human:operator"]),
  ...measurePerActor(),
};
const batched = {
  plan: plan(batchedNewestInbound, ["human:operator"]),
  ...measureBatched(),
};
db.exec(`
  CREATE INDEX idx_mesh_chat_recipient_ts
    ON mesh_chat(recipient_id, ts DESC, id DESC);
  ANALYZE;
`);
const perActorIndexed = {
  plan: plan(newestInbound, ["actor-0", "human:operator"]),
  ...measurePerActor(),
};

console.log(
  JSON.stringify(
    {
      dataset: {
        actorCount,
        messagesPerActor,
        humanMessagesPerActor,
        totalRows: actorCount * messagesPerActor,
        sweeps,
      },
      perActorUnindexed: {
        ...perActorUnindexed,
        medianMilliseconds: median(perActorUnindexed.milliseconds),
      },
      batched: {
        ...batched,
        medianMilliseconds: median(batched.milliseconds),
      },
      perActorIndexed: {
        ...perActorIndexed,
        medianMilliseconds: median(perActorIndexed.milliseconds),
      },
    },
    null,
    2
  )
);
