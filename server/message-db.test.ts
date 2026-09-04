// SQLite message-store contract: per-mutation persistence, one-time legacy
// import, deletion, and the LIKE search used by /api/search.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  closeMessageDb,
  deleteThread,
  insertMessage,
  readThread,
  messageIndexReady,
  searchMessages,
  sessionSearch,
  setActiveLeaf,
  updateMessage,
} from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const legacy = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);
const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text,
  at: Date.now(),
  ...extra,
});

describe("message-db", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("persists inserts, updates, and the active leaf across a reopen", () => {
    insertMessage("t1", msg("m1", "hello"));
    insertMessage("t1", msg("m2", "world"));
    setActiveLeaf("t1", "m2");
    updateMessage("t1", msg("m1", "hello, edited"));

    closeMessageDb(); // simulate a restart
    const thread = readThread("t1", legacy("t1"));
    expect(thread.messages.map((m) => m.text)).toEqual(["hello, edited", "world"]);
    expect(thread.activeLeafId).toBe("m2");
  });

  it("imports a legacy JSON thread file exactly once", () => {
    writeFileSync(
      legacy("t2"),
      JSON.stringify({ activeLeafId: "b", messages: [msg("a", "from json"), msg("b", "second")] }),
    );
    const imported = readThread("t2", legacy("t2"));
    expect(imported.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(imported.activeLeafId).toBe("b");
    // the file was renamed so wiped rows can never resurrect stale data
    expect(existsSync(legacy("t2"))).toBe(false);
    expect(existsSync(`${legacy("t2")}.imported`)).toBe(true);

    deleteThread("t2");
    expect(readThread("t2", legacy("t2")).messages).toEqual([]);
  });

  it("imports a pre-branching flat array file", () => {
    writeFileSync(legacy("t3"), JSON.stringify([msg("a", "one"), msg("b", "two")]));
    const imported = readThread("t3", legacy("t3"));
    expect(imported.messages).toHaveLength(2);
    expect(imported.activeLeafId).toBeNull(); // Store derives the tail
  });

  it("migrates known legacy transcripts at Store startup so search sees unopened tasks", () => {
    const initial = new Store(selection);
    const bot = initial.createBot({}, { seedMessages: false });
    closeMessageDb();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(DATA_DIR, `messages.db${suffix}`), { force: true });
    writeFileSync(legacy(bot.threadId), JSON.stringify([msg("old", "find this unopened legacy conversation")]));

    new Store(selection);
    expect(searchMessages("unopened legacy")).toMatchObject([{ threadId: bot.threadId, messageId: "old" }]);
    expect(existsSync(`${legacy(bot.threadId)}.imported`)).toBe(true);
  });

  it("stores transcripts with owner-only permissions", () => {
    insertMessage("private", msg("m1", "secret"));
    if (process.platform !== "win32") {
      expect(statSync(join(DATA_DIR, "messages.db")).mode & 0o777).toBe(0o600);
    }
  });

  it("deleteThread removes rows and state", () => {
    insertMessage("t4", msg("m1", "gone soon"));
    setActiveLeaf("t4", "m1");
    deleteThread("t4");
    const thread = readThread("t4", legacy("t4"));
    expect(thread.messages).toEqual([]);
    expect(thread.activeLeafId).toBeNull();
  });

  it("search is case-insensitive, escapes LIKE wildcards, and snips long text", () => {
    insertMessage("t5", msg("m1", "Deploy with `railway up --service workers` and verify the heartbeat"));
    insertMessage("t5", msg("m2", "totally unrelated"));
    insertMessage("t5", { ...msg("m3", "an activity chip"), kind: "activity" });
    insertMessage("t6", msg("m4", `padding start ${"x".repeat(200)} RAILWAY tail`));

    const hits = searchMessages("railway");
    expect(hits).toHaveLength(2);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes("railway"))).toBe(true);
    // long text gets windowed around the hit
    const long = hits.find((hit) => hit.threadId === "t6")!;
    expect(long.snippet.length).toBeLessThan(200);
    expect(long.snippet.startsWith("…")).toBe(true);

    // a literal % is a literal, not match-everything
    expect(searchMessages("%")).toHaveLength(0);
    insertMessage("t5", msg("m5", "50% done"));
    expect(searchMessages("%")).toHaveLength(1);
    expect(searchMessages("")).toEqual([]);

    // Current-chat find scopes in SQL before LIMIT, so busy transcripts in
    // other conversations cannot crowd out this thread's matches.
    expect(searchMessages("railway", 40, "t5").map((hit) => hit.threadId)).toEqual(["t5"]);
    expect(searchMessages("railway", 40, "missing")).toEqual([]);
  });

  it("search reports the match offset for highlighting, and finds activity chips by tool name", () => {
    insertMessage("t7", msg("m1", "please\n\n   run   the migration now"));
    insertMessage("t7", { ...msg("m2", ""), kind: "activity", role: "bot", tool: { name: "Bash: alembic upgrade head", ok: true } } as Message);
    insertMessage("t7", { ...msg("m3", "we spoke about it"), from: { botId: "b2", name: "Scout", color: "green" } } as Message);

    const text = searchMessages("the migration")[0];
    expect(text.messageId).toBe("m1");
    // whitespace folded in the snippet, offset points at the folded match
    expect(text.snippet.slice(text.matchStart, text.matchStart + text.matchLength)).toBe("the migration");

    // "which bot ran that migration" — the tool name is searchable
    const chip = searchMessages("alembic")[0];
    expect(chip).toMatchObject({ messageId: "m2", kind: "activity" });
    expect(chip.snippet).toContain("alembic upgrade head");

    // room attribution rides along
    expect(searchMessages("spoke")[0].from).toBe("Scout");
  });

  it("Store round-trips branching through the DB across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "original" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "reply" });
    const fork = store.branchMessage(bot.threadId, first.id, "edited")!;

    closeMessageDb();
    const reloaded = new Store(selection);
    const path = reloaded.activePath(bot.threadId);
    expect(path.at(-1)?.id).toBe(fork.id);
    expect(path.at(-1)?.text).toBe("edited");
    // both branches survive in the tree
    expect(reloaded.messagesFor(bot.threadId).filter((m) => m.parentId === first.parentId)).toHaveLength(2);
  });
});

// sessionSearch backs the session_search agent tool. It runs on two very
// different SQLite builds — Electron's Node 24 has FTS5, the Node that runs
// this suite may not — so every case below must hold on either path. The
// suite asserts behaviour, never which index answered.
describe("sessionSearch", () => {
  const seed = () => {
    insertMessage("t-cia", msg("c1", "The idle timer removes the Local VM container after eight hours."));
    insertMessage("t-cia", msg("c2", "Podman machine memory raised from 2 GiB to 4 GiB."));
    insertMessage("t-seo", msg("s1", "Search Console shows /screener is not indexed."));
    insertMessage("t-seo", msg("s2", "Competitor SSR comparison across three finance sites."));
    insertMessage("t-private", msg("p1", "A container question in a thread the caller cannot reach."));
  };

  it("finds a hit only inside the threads it was given", () => {
    seed();
    const hits = sessionSearch("container", ["t-cia", "t-seo"]);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.threadId !== "t-private")).toBe(true);
  });

  it("matches any term of a prose query, not the literal phrase", () => {
    // "Search Console indexed" appears as three words, never as a substring.
    // The FTS path ORs terms; the fallback has to agree, or the tool would
    // mean different things on different runtimes.
    seed();
    const hits = sessionSearch("Search Console indexed", ["t-seo"]);

    expect(hits.some((hit) => hit.snippet.includes("Search Console"))).toBe(true);
  });

  it("survives prose punctuation a model will actually type", () => {
    seed();
    expect(() => sessionSearch("what about /screener? (any update)", ["t-seo"])).not.toThrow();
    expect(sessionSearch("what about /screener?", ["t-seo"]).length).toBeGreaterThan(0);
  });

  it("returns nothing for a blank query or an empty scope", () => {
    seed();
    expect(sessionSearch("   ", ["t-cia"])).toEqual([]);
    expect(sessionSearch("container", [])).toEqual([]);
  });

  it("caps hits per thread so one busy conversation cannot crowd out the rest", () => {
    for (let i = 0; i < 8; i++) insertMessage("t-loud", msg(`l${i}`, `container note number ${i}`));
    insertMessage("t-quiet", msg("q1", "container note from the quiet thread"));

    const hits = sessionSearch("container", ["t-loud", "t-quiet"], { limit: 10, perThread: 2 });

    expect(hits.filter((hit) => hit.threadId === "t-loud").length).toBeLessThanOrEqual(2);
    expect(hits.some((hit) => hit.threadId === "t-quiet")).toBe(true);
  });

  it("honours the overall limit", () => {
    for (let i = 0; i < 12; i++) insertMessage(`t-${i}`, msg(`m${i}`, `container ${i}`));
    const threads = Array.from({ length: 12 }, (_, i) => `t-${i}`);

    expect(sessionSearch("container", threads, { limit: 5 }).length).toBeLessThanOrEqual(5);
  });

  it("indexes an activity chip by its tool name, like the sidebar search does", () => {
    insertMessage(
      "t-tools",
      msg("a1", "", { kind: "activity", tool: { name: "browser_navigate", ok: true } } as Partial<Message>),
    );

    expect(sessionSearch("browser_navigate", ["t-tools"]).length).toBeGreaterThan(0);
  });

  it("reports which index answered, so a runtime without FTS5 is visible", () => {
    expect(typeof messageIndexReady()).toBe("boolean");
  });
});
