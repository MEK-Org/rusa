import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Longest a heading may be. Enforced at the write boundary, not here. */
const TITLE_MAX = 200;

/**
 * Split an obligation into a heading and a body.
 *
 * `intent` was doing both jobs, and the cost showed up the first time a real
 * model wrote one: a live root produced a five-paragraph `intent`, which the
 * dashboard then rendered as the card's title, because the title is all the
 * card has. A node that costs five paragraphs to create is a node an actor
 * thinks twice about creating — which is the wrong pressure, since the whole
 * design wants filing a question to be cheap enough to do mid-conversation.
 *
 * So `title` is the heading — short, scannable in a queue, the thing #1485's
 * "enumerable call-list" actually needs — and `intent` keeps its ratified
 * meaning as the fuller statement of what should become true.
 *
 * **Backfill takes the first line of `intent`.** Unlike 0025's timestamps this
 * is derivation from real data rather than invention: in every row written so
 * far the first line genuinely is the heading ("Understand the Space.",
 * "Delve is a game people want to keep playing."). `intent` is left untouched,
 * so nothing is destroyed and the derivation is reversible. Rows with no intent
 * at all get no title, which reads as "never had a heading" — true.
 *
 * Neither staging nor production has meaningfully adopted obligations
 * (operator, 2026-08-30), so this deliberately does not attempt a table rebuild
 * to make the column NOT NULL. Presence is required at the repository boundary
 * instead, which is where a caller can be told what went wrong.
 */
export const obligationTitle: Migration = {
  id: "0027_obligation_title",
  up: (db: Database) => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(obligations)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    if (!columns.has("title")) {
      db.exec(
        `ALTER TABLE obligations ADD COLUMN title TEXT
           CHECK (
             title IS NULL
             OR (
               length(trim(title, char(32) || char(9) || char(10) || char(13))) > 0
               AND length(title) <= ${TITLE_MAX}
             )
           )`
      );

      // First line of intent, capped. `instr` returns 0 when there is no
      // newline, in which case the whole (capped) intent is the heading. The
      // derived value is tested in the WHERE rather than cleaned up afterwards:
      // the column CHECK applies to UPDATE too, so writing a blank title would
      // raise a constraint error instead of falling through.
      const FIRST_LINE = `substr(
        CASE
          WHEN instr(intent, char(10)) > 0 THEN substr(intent, 1, instr(intent, char(10)) - 1)
          ELSE intent
        END,
        1,
        ${TITLE_MAX}
      )`;
      const WHITESPACE = "char(32) || char(9) || char(10) || char(13)";

      db.exec(`
        UPDATE obligations
        SET title = ${FIRST_LINE}
        WHERE title IS NULL
          AND intent IS NOT NULL
          AND length(trim(${FIRST_LINE}, ${WHITESPACE})) > 0
      `);
    }
  },
};
