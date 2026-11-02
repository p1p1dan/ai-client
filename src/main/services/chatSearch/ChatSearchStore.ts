/**
 * Chat search: the sqlite cache behind `ChatSearchIndex`
 * (docs/plantree/plans/chat-search README §3.1).
 *
 * One row per indexed message, mirrored into an FTS5 table with the trigram
 * tokenizer so a substring of any script matches (「良率」 inside 「批次良率分析」).
 * Queries shorter than three characters cannot use trigrams and scan with
 * `LIKE` instead.
 *
 * The file is a cache. When it cannot be opened, reads back as a TSD-encrypted
 * file (`%TSD-Header-###%`, the encrypted Windows target) or turns out corrupt
 * later, it is deleted and rebuilt; when even that fails the store lives in
 * memory for this run. Every operation goes through one queue, so a query
 * never observes half of a session's rewrite.
 */

import { open as openFile, unlink } from 'node:fs/promises';
import sqlite3 from 'sqlite3';
import { isTsdEncrypted } from '../../utils/tsdSafeRead';
import type { IndexedMessage } from './extract';

/** Bump to drop and rebuild every existing cache file. */
export const CHAT_SEARCH_SCHEMA_VERSION = 1;

const MEMORY = ':memory:';
const BUSY_TIMEOUT_MS = 3000;

export interface StoredSessionState {
  sessionId: string;
  /** The session index's `updatedAt` the rows were read under. */
  updatedAt: number;
}

export interface MessageHit {
  id: number;
  sessionId: string;
  messageKey: string;
  ord: number;
  role: 'user' | 'assistant';
}

export interface ChatSearchStoreOptions {
  /** Absolute path of the cache file, or `:memory:`. */
  dbPath: string;
  log?: (line: string, error?: unknown) => void;
}

type Db = sqlite3.Database;

function openDb(path: string): Promise<Db> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(
      path,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      (error: Error | null) => (error ? reject(error) : resolve(db))
    );
  });
}

function closeDb(db: Db): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

function run(db: Db, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (error: Error | null) => (error ? reject(error) : resolve()))
  );
}

function exec(db: Db, sql: string): Promise<void> {
  return new Promise((resolve, reject) =>
    db.exec(sql, (error: Error | null) => (error ? reject(error) : resolve()))
  );
}

function all<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (error: Error | null, rows: T[]) => (error ? reject(error) : resolve(rows)))
  );
}

async function fileIsTsdEncrypted(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(path, 'r');
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return isTsdEncrypted(head.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    await unlink(`${path}${suffix}`).catch((error: NodeJS.ErrnoException) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

/** Errors that mean the file itself is bad, as opposed to a bad statement. */
export function isCorruptionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB';
}

/** A literal FTS5 phrase: the text in double quotes, inner quotes doubled. */
function ftsPhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Trigram matching needs three characters (code points). */
export function usesTrigram(text: string): boolean {
  return [...text].length >= 3;
}

export class ChatSearchStore {
  private readonly dbPath: string;
  private readonly log: (line: string, error?: unknown) => void;
  private db: Db | null = null;
  private opening: Promise<Db> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private fts = true;
  /** Where the store ended up: the file, a rebuilt file, or memory. */
  private location: 'file' | 'rebuilt' | 'memory' = 'file';
  /** Fired when the rows were lost (rebuild or memory fallback), so the owner re-indexes. */
  onReset: (() => void) | null = null;

  constructor(options: ChatSearchStoreOptions) {
    this.dbPath = options.dbPath;
    this.log = options.log ?? ((line, error) => console.warn(`[chat-search] ${line}`, error ?? ''));
  }

  /** Diagnostics: where the rows live, and whether trigram search is available. */
  describe(): { location: 'file' | 'rebuilt' | 'memory'; fts: boolean } {
    return { location: this.location, fts: this.fts };
  }

  async close(): Promise<void> {
    const db = await this.opening?.catch(() => null);
    this.opening = null;
    this.db = null;
    if (db) await closeDb(db);
  }

  // ---- open, rebuild, fall back ------------------------------------------------

  private async connection(): Promise<Db> {
    if (this.db) return this.db;
    if (!this.opening) {
      this.opening = this.openWithFallback().then((db) => {
        this.db = db;
        return db;
      });
      this.opening.catch(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private async openWithFallback(): Promise<Db> {
    if (this.dbPath !== MEMORY) {
      if (await fileIsTsdEncrypted(this.dbPath)) {
        this.log(`cache file reads back encrypted, rebuilding: ${this.dbPath}`);
      } else {
        try {
          return await this.openAndPrepare(this.dbPath);
        } catch (error) {
          this.log(`cache file unusable, rebuilding: ${this.dbPath}`, error);
        }
      }
      try {
        await removeDbFiles(this.dbPath);
        const db = await this.openAndPrepare(this.dbPath);
        this.location = 'rebuilt';
        return db;
      } catch (error) {
        this.log('cannot rebuild the cache file, keeping the index in memory', error);
      }
    }
    const db = await this.openAndPrepare(MEMORY);
    this.location = 'memory';
    return db;
  }

  private async openAndPrepare(path: string): Promise<Db> {
    const db = await openDb(path);
    try {
      db.configure('busyTimeout', BUSY_TIMEOUT_MS);
      const [{ user_version: version } = { user_version: 0 }] = await all<{
        user_version: number;
      }>(db, 'PRAGMA user_version');
      if (version !== CHAT_SEARCH_SCHEMA_VERSION) {
        if (version !== 0) {
          // An older or newer layout: it is a cache, start over.
          await exec(
            db,
            'DROP TABLE IF EXISTS messages_fts; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS sessions;'
          );
        }
        await this.createSchema(db);
        await run(db, `PRAGMA user_version = ${CHAT_SEARCH_SCHEMA_VERSION}`);
      } else {
        const ftsTables = await all<{ name: string }>(
          db,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'"
        );
        this.fts = ftsTables.length > 0;
      }
      // Touch every table: a file that is not a database fails here, not mid-query.
      await all(db, 'SELECT count(*) AS n FROM sessions');
      await all(db, 'SELECT count(*) AS n FROM messages');
      await run(db, 'PRAGMA synchronous = NORMAL');
      return db;
    } catch (error) {
      await closeDb(db);
      throw error;
    }
  }

  private async createSchema(db: Db): Promise<void> {
    await exec(
      db,
      `CREATE TABLE IF NOT EXISTS sessions (
         session_id TEXT PRIMARY KEY,
         updated_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS messages (
         id INTEGER PRIMARY KEY,
         session_id TEXT NOT NULL,
         message_key TEXT NOT NULL,
         ord INTEGER NOT NULL,
         role TEXT NOT NULL,
         body TEXT NOT NULL,
         ts INTEGER
       );
       CREATE INDEX IF NOT EXISTS messages_by_session ON messages(session_id, ord);`
    );
    try {
      await exec(
        db,
        `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
           body, content='messages', content_rowid='id', tokenize='trigram'
         );
         CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
           INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
         END;
         CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
           INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
         END;`
      );
      this.fts = true;
    } catch (error) {
      // A build without FTS5 trigram: every query scans with LIKE.
      this.log('FTS5 trigram unavailable, falling back to LIKE', error);
      this.fts = false;
    }
  }

  /** The file went bad under us: drop it and start over (memory if that fails too). */
  private async reset(reason: unknown): Promise<void> {
    this.log('cache file became unreadable, rebuilding', reason);
    const db = this.db;
    this.db = null;
    this.opening = null;
    if (db) await closeDb(db);
    if (this.dbPath !== MEMORY) {
      try {
        await removeDbFiles(this.dbPath);
      } catch (error) {
        this.log('cannot delete the broken cache file', error);
      }
    }
    this.onReset?.();
  }

  /** Every operation in order; a corruption error resets the store and is rethrown. */
  private enqueue<T>(work: (db: Db) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const db = await this.connection();
      try {
        return await work(db);
      } catch (error) {
        if (isCorruptionError(error)) await this.reset(error);
        throw error;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  // ---- reads ---------------------------------------------------------------------

  sessionStates(): Promise<StoredSessionState[]> {
    return this.enqueue((db) =>
      all<StoredSessionState>(
        db,
        'SELECT session_id AS sessionId, updated_at AS updatedAt FROM sessions'
      )
    );
  }

  /**
   * Candidate messages containing `text`, case-insensitively, in session and
   * message order. Bodies are not returned; see {@link bodies}.
   */
  findMessages(text: string): Promise<MessageHit[]> {
    return this.enqueue((db) => {
      const columns =
        'm.id AS id, m.session_id AS sessionId, m.message_key AS messageKey, m.ord AS ord, m.role AS role';
      if (this.fts && usesTrigram(text)) {
        return all<MessageHit>(
          db,
          `SELECT ${columns} FROM messages m
             WHERE m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)
             ORDER BY m.session_id, m.ord`,
          [ftsPhrase(text)]
        );
      }
      return all<MessageHit>(
        db,
        `SELECT ${columns} FROM messages m WHERE m.body LIKE ? ESCAPE '\\' ORDER BY m.session_id, m.ord`,
        [likePattern(text)]
      );
    });
  }

  async bodies(ids: readonly number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    const rows = await this.enqueue((db) =>
      all<{ id: number; body: string }>(
        db,
        `SELECT id, body FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`,
        [...ids]
      )
    );
    for (const row of rows) out.set(row.id, row.body);
    return out;
  }

  // ---- writes --------------------------------------------------------------------

  /** Replace one session's rows, stamped with the `updatedAt` they were read under. */
  replaceSession(
    sessionId: string,
    updatedAt: number,
    messages: readonly IndexedMessage[]
  ): Promise<void> {
    return this.enqueue(async (db) => {
      await run(db, 'BEGIN IMMEDIATE');
      try {
        await run(db, 'DELETE FROM messages WHERE session_id = ?', [sessionId]);
        for (const [ord, message] of messages.entries()) {
          await run(
            db,
            'INSERT INTO messages (session_id, message_key, ord, role, body, ts) VALUES (?, ?, ?, ?, ?, ?)',
            [sessionId, message.key, ord, message.role, message.text, message.timestamp ?? null]
          );
        }
        await run(
          db,
          'INSERT INTO sessions (session_id, updated_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at',
          [sessionId, updatedAt]
        );
        await run(db, 'COMMIT');
      } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  removeSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return Promise.resolve();
    return this.enqueue(async (db) => {
      await run(db, 'BEGIN IMMEDIATE');
      try {
        for (const sessionId of sessionIds) {
          await run(db, 'DELETE FROM messages WHERE session_id = ?', [sessionId]);
          await run(db, 'DELETE FROM sessions WHERE session_id = ?', [sessionId]);
        }
        await run(db, 'COMMIT');
      } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }
}
