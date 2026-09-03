import { afterEach, describe, expect, it } from "vitest";

import {
  appendDraftAttachments,
  changeDraftAttachmentPending,
  getDraft,
  getDraftAttachments,
  isDraftAttachmentPending,
  setDraft,
  setDraftAttachments,
} from "./drafts";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("durable attachment completion", () => {
  it("appends to the keyed draft without a mounted React state updater", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    appendDraftAttachments("bot:a:thread-a", [{
      kind: "file",
      id: "file-1",
      path: "/private/attachments/file.pdf",
      name: "file.pdf",
      size: 42,
    }]);
    expect(getDraftAttachments(store, "bot:a:thread-a")).toHaveLength(1);
    expect(getDraftAttachments(store, "bot:b:thread-b")).toEqual([]);
  });

  it("merges with the live in-memory draft when storage rejects writes", () => {
    const readable = memoryStorage();
    const store: Storage = {
      ...readable,
      setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:quota:thread-quota";
    setDraft(store, draftId, "keep this text");
    setDraftAttachments(store, draftId, [{
      kind: "file",
      id: "existing",
      path: "/private/attachments/existing.pdf",
      name: "existing.pdf",
      size: 10,
    }]);

    appendDraftAttachments(draftId, [{
      kind: "file",
      id: "late",
      path: "/private/attachments/late.pdf",
      name: "late.pdf",
      size: 20,
    }]);

    expect(getDraft(store, draftId)).toBe("keep this text");
    expect(getDraftAttachments(store, draftId).map((attachment) => attachment.id))
      .toEqual(["existing", "late"]);
  });

  it("keeps concurrent pending uploads scoped to their originating draft", () => {
    changeDraftAttachmentPending("bot:pending:a", true);
    changeDraftAttachmentPending("bot:pending:a", true);
    changeDraftAttachmentPending("bot:pending:b", true);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(true);
    expect(isDraftAttachmentPending("bot:pending:b")).toBe(true);

    // A completion decrements only one operation; extra completions clamp at
    // zero rather than poisoning a later upload with a negative count.
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:a", false);
    changeDraftAttachmentPending("bot:pending:b", false);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(false);
    expect(isDraftAttachmentPending("bot:pending:b")).toBe(false);

    // Starting again after the balanced cleanup remains a fresh pending item.
    changeDraftAttachmentPending("bot:pending:a", true);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(true);
    changeDraftAttachmentPending("bot:pending:a", false);
    expect(isDraftAttachmentPending("bot:pending:a")).toBe(false);
  });
});
