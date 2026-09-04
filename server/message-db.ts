// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import type { Message } from "./store.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  // Transcripts can contain private conversations and tool output. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask.
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
  `);
  ftsReady = installFts(db);
  return db;
}

/** Whether this runtime's SQLite has FTS5, decided once per handle.
 *
 * It is not a given. Electron's Node 24 ships it; the Node that runs `vitest`
 * on a contributor's machine may not, and `CREATE VIRTUAL TABLE … USING fts5`
 * throws "no such module: fts5" there. So the index is an accelerator, never a
 * requirement: `sessionSearch` falls back to the same LIKE scan the sidebar has
 * always used, which is correct — only slower — on a local transcript. */
let ftsReady = false;

export function messageIndexReady(): boolean {
  return ftsReady;
}

/** An external-content FTS5 index over the searchable part of a message.
 *
 * External content keeps one copy of the text: the index stores terms, the row
 * stays in `messages`. Triggers mirror every write, so nothing in the existing
 * write paths has to remember the index exists.
 *
 * The content source is a VIEW, not `messages` itself. FTS5 resolves external
 * content by column name, and a searchable "body" is not a column here — it is
 * a text message's body OR an activity chip's tool name, the same two fields
 * `searchMessages` scans. Pointing `content` straight at `messages` compiles
 * and then fails every read with "no such column: T.body"; the view supplies
 * the column FTS5 is looking for. */
function installFts(db: DatabaseSync): boolean {
  try {
    db.exec(`
      CREATE VIEW IF NOT EXISTS messages_body AS
        SELECT rowid AS rowid, coalesce(text, json_extract(json, '$.tool.name'), '') AS body
        FROM messages;
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        body,
        content = 'messages_body',
        content_rowid = 'rowid',
        tokenize = 'porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (rowid, body)
        VALUES (new.rowid, coalesce(new.text, json_extract(new.json, '$.tool.name'), ''));
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body)
        VALUES ('delete', old.rowid, coalesce(old.text, json_extract(old.json, '$.tool.name'), ''));
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, body)
        VALUES ('delete', old.rowid, coalesce(old.text, json_extract(old.json, '$.tool.name'), ''));
        INSERT INTO messages_fts (rowid, body)
        VALUES (new.rowid, coalesce(new.text, json_extract(new.json, '$.tool.name'), ''));
      END;
    `);
    // Backfill once, for transcripts written before the index existed. The
    // rebuild command reads straight from the content table, so it costs one
    // pass over rows that are already on disk.
    const indexed = db.prepare("SELECT count(*) AS n FROM messages_fts").get() as { n: number };
    const stored = db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number };
    if (indexed.n !== stored.n) {
      db.exec("INSERT INTO messages_fts (messages_fts) VALUES ('rebuild')");
    }
    return true;
  } catch {
    return false;
  }
}

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

const rowToMessage = (row: { json: string }): Message => JSON.parse(row.json) as Message;

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId }; // fresh thread
  }
  if (Array.isArray(raw)) messages = raw as Message[]; // pre-branching flat file
  else if (raw && typeof raw === "object") {
    messages = ((raw as { messages?: Message[] }).messages ?? []) as Message[];
    activeLeafId = (raw as { activeLeafId?: string | null }).activeLeafId ?? null;
  }
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

export function insertMessage(threadId: string, message: Message): void {
  db()
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function updateMessage(threadId: string, message: Message): void {
  db()
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
}

/** Goal cards are new SQLite-backed messages, so crash recovery can locate
 * the tiny set of unfinished receipts without eagerly loading every room
 * transcript into memory at startup. */
export function workingGoalRunMessages(): Array<{ threadId: string; message: Message }> {
  const rows = db()
    .prepare(
      "SELECT thread_id, json FROM messages " +
      "WHERE kind = 'goal.run' AND json_extract(json, '$.goalRun.status') = 'working'",
    )
    .all() as Array<{ thread_id: string; json: string }>;
  return rows.map((row) => ({ threadId: row.thread_id, message: JSON.parse(row.json) as Message }));
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function deleteThread(threadId: string): void {
  db().prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
  db().prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Case-insensitive substring search over text messages, newest first.
 * A LIKE scan, deliberately: local transcripts are megabytes at most, a
 * scan is milliseconds, and it needs no FTS extension to exist. */
export function searchMessages(query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const scope = threadId ? "thread_id = ? AND " : "";
  const statement = db().prepare(
    "SELECT thread_id, id, at, role, kind, text, json_extract(json, '$.tool.name') AS tool_name, json_extract(json, '$.from.name') AS from_name FROM messages " +
      `WHERE ${scope}((kind = 'text' AND text IS NOT NULL AND lower(text) LIKE ? ESCAPE '\\') ` +
      "   OR (kind = 'activity' AND tool_name IS NOT NULL AND lower(tool_name) LIKE ? ESCAPE '\\')) " +
      "ORDER BY at DESC LIMIT ?",
  );
  const rows = (threadId
    ? statement.all(threadId, pattern, pattern, limit)
    : statement.all(pattern, pattern, limit)) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
  return rows.map((row) => {
    const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
}

export interface SessionSearchHit extends SearchHit {
  /** Which bot's conversation this came from, resolved by the caller. */
  botId?: string;
}

/** Recall across a named set of threads, for the `session_search` tool.
 *
 * Differs from `searchMessages` in three ways, all because the reader is a
 * model rather than a person scrolling a sidebar:
 *
 *  - the caller passes the exact threads it may see, so scoping is decided by
 *    the harness (which knows who can reach whom) and never by this file
 *  - ranked by relevance when FTS5 is present, not by recency, because a model
 *    asking "what did we conclude about X" wants the best hit, not the newest
 *  - capped per thread, so one chatty conversation cannot crowd out the rest
 *
 * With no FTS5 it degrades to the same LIKE scan `searchMessages` uses. Same
 * results, same shape, slower on a large transcript — which beats the tool not
 * existing on that runtime.
 */
export function sessionSearch(
  query: string,
  threadIds: readonly string[],
  { limit = 20, perThread = 4 }: { limit?: number; perThread?: number } = {},
): SessionSearchHit[] {
  const needle = query.trim();
  if (!needle || threadIds.length === 0) return [];

  const slots = threadIds.map(() => "?").join(",");
  const rows = ftsReady
    ? ftsRows(needle, threadIds, slots, limit)
    : likeRows(needle, threadIds, slots, limit);

  const perThreadCount = new Map<string, number>();
  const hits: SessionSearchHit[] = [];
  for (const row of rows) {
    const seen = perThreadCount.get(row.thread_id) ?? 0;
    if (seen >= perThread) continue;
    perThreadCount.set(row.thread_id, seen + 1);
    hits.push(rowToHit(row, needle));
    if (hits.length >= limit) break;
  }
  return hits;
}

interface SearchRow {
  thread_id: string;
  id: string;
  at: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  from_name: string | null;
}

const SELECT_COLUMNS =
  "m.thread_id AS thread_id, m.id AS id, m.at AS at, m.role AS role, m.kind AS kind, m.text AS text, " +
  "json_extract(m.json, '$.tool.name') AS tool_name, json_extract(m.json, '$.from.name') AS from_name";

function ftsRows(needle: string, threadIds: readonly string[], slots: string, limit: number): SearchRow[] {
  // Quote every term and OR them: a model writes prose, not FTS syntax, and an
  // unquoted apostrophe or hyphen is a syntax error rather than zero results.
  const terms = queryTerms(needle);
  if (terms.length === 0) return [];
  const match = terms.map((term) => `"${term}"`).join(" OR ");
  return db()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM messages_fts f JOIN messages m ON m.rowid = f.rowid ` +
        `WHERE messages_fts MATCH ? AND m.thread_id IN (${slots}) ` +
        "ORDER BY f.rank LIMIT ?",
    )
    .all(match, ...threadIds, limit * 4) as unknown as SearchRow[];
}

/** Terms of a prose query, deduped and bounded.
 *
 * Both paths match ANY term rather than the literal phrase. Without this the
 * fallback answers a different question from the index — "Search Console
 * indexed" finds nothing as a substring but three rows as terms — and a tool
 * whose meaning depends on the runtime is worse than a slow one. */
function queryTerms(needle: string): string[] {
  const terms = needle.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(terms)].slice(0, 8);
}

function likeRows(needle: string, threadIds: readonly string[], slots: string, limit: number): SearchRow[] {
  const terms = queryTerms(needle);
  if (terms.length === 0) return [];
  const patterns = terms.map((term) => `%${term.replace(/([\\%_])/g, "\\$1")}%`);
  const anyTerm = (column: string) =>
    patterns.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" OR ");
  return db()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM messages m ` +
        `WHERE m.thread_id IN (${slots}) AND ` +
        `((m.kind = 'text' AND m.text IS NOT NULL AND (${anyTerm("lower(m.text)")})) ` +
        " OR (m.kind = 'activity' AND json_extract(m.json, '$.tool.name') IS NOT NULL " +
        `     AND (${anyTerm("lower(json_extract(m.json, '$.tool.name'))")}))) ` +
        "ORDER BY m.at DESC LIMIT ?",
    )
    .all(...threadIds, ...patterns, ...patterns, limit * 4) as unknown as SearchRow[];
}

function rowToHit(row: SearchRow, needle: string): SessionSearchHit {
  const haystack = row.kind === "activity" ? (row.tool_name ?? "") : (row.text ?? "");
  const first = needle.match(/[\p{L}\p{N}_]+/u)?.[0]?.toLowerCase() ?? needle.toLowerCase();
  const hitAt = Math.max(0, haystack.toLowerCase().indexOf(first));
  const start = Math.max(0, hitAt - 80);
  const end = Math.min(haystack.length, hitAt + 200);
  const head = start > 0 ? "…" : "";
  const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  const matchStart = body.toLowerCase().indexOf(first);
  return {
    threadId: row.thread_id,
    messageId: row.id,
    at: row.at,
    role: row.role,
    kind: row.kind,
    snippet: head + body + (end < haystack.length ? "…" : ""),
    matchStart: matchStart < 0 ? head.length : matchStart + head.length,
    matchLength: matchStart < 0 ? 0 : first.length,
    ...(row.from_name ? { from: row.from_name } : {}),
  };
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
