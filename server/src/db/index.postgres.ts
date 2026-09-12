import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { pool, bind as bindNamed, redact } from './postgres.js';

/**
 * PostgreSQL-backed replacement for the current db/index.ts (better-sqlite3).
 * NOT wired in yet — see the note at the bottom of this file and the PR
 * description for why, and what "wiring it in" actually involves.
 *
 * Section 4 of the brief asks whether the existing db/index.ts can safely
 * become a compatibility layer so the ~60 consumer files don't need a full
 * API rewrite. The honest answer: partially, and only in call SHAPE, never in
 * calling CONVENTION — `better-sqlite3` is synchronous, `pg` is not, and
 * there is no safe way to make an async database driver look synchronous
 * (the unsafe way is a blocking worker-thread bridge, which the brief
 * explicitly rules out — "do NOT create an unsafe fake SQLite API"). So every
 * call site still needs `await` added and its enclosing function marked
 * `async` — that part is unavoidable and is real, mechanical, per-file work.
 *
 * What THIS module does preserve exactly, so that work is as mechanical and
 * low-risk as possible:
 *  - `db.prepare(sql).get(...)/.all(...)/.run(...)` — identical shape, now Promise-returning.
 *  - Both existing calling conventions this codebase actually uses:
 *      • positional  `?, ?, ?` with `.get(a, b, c)`      (the majority — ~3000+ sites)
 *      • named       `@id, @name` with `.get({ id, name })`
 *  - `db.prepare<[string], UserRow>(sql)` — the same generic-typed call shape
 *    already used at 268 sites, so those type annotations don't need touching.
 *  - `transact(fn)` — same call shape (a callback that "just uses `db`"), but
 *    now async. Re-entrant/nested transact() calls (this codebase has them —
 *    e.g. dailyRigReport.ts's approve handler calls transact(() => { ...
 *    saveReport(...) ... }) where saveReport() ALSO calls transact() itself)
 *    are handled via AsyncLocalStorage: the OUTERMOST transact() opens the
 *    real BEGIN/COMMIT on one pooled client; anything nested inside it —
 *    including calls that reach back into `db.prepare(...)` from a totally
 *    different file — transparently reuses that same client and issues no
 *    second BEGIN. This is what lets 60 files keep calling `db.prepare(...)`
 *    as a bare module-level import and still get correct transactional
 *    behavior, without threading a client/query object through every
 *    function signature by hand.
 *  - `.run(...).changes` — the one field actually read off a `.run()` result
 *    anywhere in this codebase (services/demoData.ts:365); `lastInsertRowid`
 *    is never used (every id here is application-generated, util/id.ts), so
 *    it is intentionally not provided.
 *  - `db.exec(sql)` — used once outside migrations (services/demoData.ts:384).
 *  - `db.pragma(...)` — kept as a callable no-op. WAL mode, the foreign-key
 *    switch and the busy-timeout tuning it configured have no PostgreSQL
 *    equivalent call site (FKs are always enforced; connection pooling
 *    replaces the busy-timeout problem); no consumer reads its return value.
 */

const transactionContext = new AsyncLocalStorage<PoolClient>();

function activeConnection(): Pool | PoolClient {
  return transactionContext.getStore() ?? pool;
}

/** `?` -> `$1, $2, ...` in strict left-to-right order, values passed through unchanged (already in matching order). */
function bindPositional(sql: string, args: unknown[]): { text: string; values: unknown[] } {
  let n = 0;
  const text = sql.replace(/\?/g, () => `$${++n}`);
  return { text, values: args };
}

/** A single plain-object argument is this codebase's `@name` convention; anything else (including zero args) is positional `?`. */
function isNamedParamsCall(args: unknown[]): args is [Record<string, unknown>] {
  return args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0]);
}

async function runOn(conn: Pool | PoolClient, sql: string, args: unknown[]) {
  const { text, values } = isNamedParamsCall(args) ? bindNamed(sql, args[0]) : bindPositional(sql, args);
  try {
    return await conn.query(text, values);
  } catch (err) {
    throw new Error(`${redact((err as Error).message)} — while running: ${text.trim().slice(0, 300)}`);
  }
}

export interface PreparedStatement<Params extends unknown[] = unknown[], Result = Record<string, unknown>> {
  get(...params: Params): Promise<Result | undefined>;
  all(...params: Params): Promise<Result[]>;
  run(...params: Params): Promise<{ changes: number; rows: Result[] }>;
}

export const db = {
  prepare<Params extends unknown[] = unknown[], Result = Record<string, unknown>>(
    sql: string,
  ): PreparedStatement<Params, Result> {
    return {
      async get(...params: Params) {
        const res = await runOn(activeConnection(), sql, params);
        return res.rows[0] as Result | undefined;
      },
      async all(...params: Params) {
        const res = await runOn(activeConnection(), sql, params);
        return res.rows as Result[];
      },
      async run(...params: Params) {
        const res = await runOn(activeConnection(), sql, params);
        return { changes: res.rowCount ?? 0, rows: res.rows as Result[] };
      },
    };
  },

  async exec(sql: string): Promise<void> {
    await activeConnection().query(sql);
  },

  /** No-op — see the file header. Kept callable so `db.pragma('...')` call sites need no change. */
  pragma(_sql: string): undefined {
    return undefined;
  },
};

/**
 * Runs fn with every `db.prepare(...)` call made during it — directly, or
 * from any function it calls, in any file — routed onto ONE pooled
 * connection inside one BEGIN/COMMIT. A transact() invoked while already
 * inside another one is a no-op wrapper around fn(): it reuses the active
 * connection rather than opening a second one or issuing a nested BEGIN,
 * which matches how the SQLite version of this codebase already behaved
 * (better-sqlite3 has exactly one connection, so "nested" transactions were
 * always really just the same transaction).
 */
export async function transact<T>(fn: () => T | Promise<T>): Promise<T> {
  const existing = transactionContext.getStore();
  if (existing) return await fn();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await transactionContext.run(client, () => fn());
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', redact((rollbackErr as Error).message));
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * NOT wired in. Cutting over means: this file (or its contents) becomes
 * db/index.ts, and every one of the ~60 consumer files that currently calls
 * `db.prepare(...).get(x)` synchronously now gets back a Promise instead of a
 * value — which `tsc --noEmit` will refuse to compile at every single call
 * site that isn't `await`ed (accessing a property on a `Promise<T>`, passing
 * one to something expecting `T`, etc.). That compiler output is the exact,
 * complete, un-missable checklist of every remaining edit — which is the
 * point of preserving the call shape this closely. But it means the cutover
 * has to happen as one continuous pass per file (a file either fully
 * compiles with `await` added everywhere it needs it, or it doesn't compile
 * at all) and, since I do not yet have PostgreSQL credentials for this
 * environment, none of it has been runtime-verified against a real database
 * yet — only the transaction re-entrancy logic and the parameter binding
 * (both positional `?` and named `@x`) have been exercised, against a mock
 * pool and unit tests respectively, with no live connection required.
 */
