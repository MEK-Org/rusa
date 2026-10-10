import type { Migration } from "../../db/migrations/types.js";
import { coordinatorSchemaV3 } from "./0001_coordinator_schema_v3.js";
import { parserWordingRevisions } from "./0002_parser_wording_revisions.js";

/**
 * Registry of quota.db migrations in the order they should be applied. New
 * schema changes append here as 0003_…, 0004_…, etc.
 *
 * A change that a pre-change binary cannot safely read or write must also
 * raise `QUOTA_SCHEMA_VERSION`, which the runner stamps into `user_version`,
 * so that older binaries refuse the database instead of misreading it.
 * Additive changes leave the version alone.
 */
export const quotaMigrations: Migration[] = [coordinatorSchemaV3, parserWordingRevisions];
