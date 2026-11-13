import {
  SandboxAgent,
  SandboxRecord,
  SandboxSize,
  SandboxState,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const SandboxRow = Schema.Struct({
  threadId: ThreadId,
  name: Schema.String,
  boatSandboxId: Schema.NullOr(Schema.String),
  idempotencyKey: Schema.String,
  state: SandboxState,
  size: SandboxSize,
  agent: SandboxAgent,
  remoteCwd: Schema.NullOr(Schema.String),
  lastActiveAt: Schema.String,
  createdAt: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type SandboxRow = typeof SandboxRow.Type;

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(SandboxRow));

export const toSandboxRecord = (row: SandboxRow): SandboxRecord => ({
  threadId: row.threadId,
  name: row.name,
  boatSandboxId: row.boatSandboxId,
  state: row.state,
  size: row.size,
  agent: row.agent,
  lastActiveAt: row.lastActiveAt,
  createdAt: row.createdAt,
  error: row.error,
});

/**
 * The table is created here rather than in the upstream migration list, so a fork rebase never
 * collides with upstream's next migration number.
 */
export const makeSandboxRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS sandbox_threads (
      thread_id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      boat_sandbox_id TEXT,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL,
      size TEXT NOT NULL,
      agent TEXT NOT NULL,
      remote_cwd TEXT,
      last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      error TEXT
    )
  `;

  return {
    list: sql`
      SELECT
        thread_id AS "threadId",
        name AS "name",
        boat_sandbox_id AS "boatSandboxId",
        idempotency_key AS "idempotencyKey",
        state AS "state",
        size AS "size",
        agent AS "agent",
        remote_cwd AS "remoteCwd",
        last_active_at AS "lastActiveAt",
        created_at AS "createdAt",
        error AS "error"
      FROM sandbox_threads
      ORDER BY created_at
    `.pipe(Effect.flatMap(decodeRows)),
    get: (threadId: ThreadId) =>
      sql`
        SELECT
          thread_id AS "threadId",
          name AS "name",
          boat_sandbox_id AS "boatSandboxId",
          idempotency_key AS "idempotencyKey",
          state AS "state",
          size AS "size",
          agent AS "agent",
          remote_cwd AS "remoteCwd",
          last_active_at AS "lastActiveAt",
          created_at AS "createdAt",
          error AS "error"
        FROM sandbox_threads
        WHERE thread_id = ${threadId}
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows[0] ?? null),
      ),
    upsert: (row: SandboxRow) =>
      sql`
        INSERT INTO sandbox_threads (
          thread_id, name, boat_sandbox_id, idempotency_key, state, size, agent, remote_cwd,
          last_active_at, created_at, error
        ) VALUES (
          ${row.threadId}, ${row.name}, ${row.boatSandboxId}, ${row.idempotencyKey}, ${row.state},
          ${row.size}, ${row.agent}, ${row.remoteCwd}, ${row.lastActiveAt}, ${row.createdAt},
          ${row.error}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          boat_sandbox_id = excluded.boat_sandbox_id,
          idempotency_key = excluded.idempotency_key,
          state = excluded.state,
          size = excluded.size,
          agent = excluded.agent,
          remote_cwd = excluded.remote_cwd,
          last_active_at = excluded.last_active_at,
          error = excluded.error
      `.pipe(Effect.asVoid),
    remove: (threadId: ThreadId) =>
      sql`DELETE FROM sandbox_threads WHERE thread_id = ${threadId}`.pipe(Effect.asVoid),
  };
});

export type SandboxRecords = Effect.Success<typeof makeSandboxRecords>;
