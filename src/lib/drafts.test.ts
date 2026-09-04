import { afterEach, describe, expect, it } from "vitest";

import {
  appendDraftAttachments,
  changeDraftAttachmentPending,
  getDraft,
  getDraftAttachments,
  isDraftAttachmentPending,
  replaceDraftAttachment,
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
  it("keeps blob previews in memory but never writes them into durable storage", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:preview:thread-preview";
    setDraftAttachments(store, draftId, [
      {
        kind: "image",
        id: "uploading",
        path: "",
        name: "uploading.png",
        size: 3,
        mime: "image/png",
        previewUrl: "blob:uploading",
        uploading: true,
      },
      {
        kind: "image",
        id: "ready",
        path: "/private/attachments/ready.png",
        name: "ready.png",
        size: 4,
        mime: "image/png",
        previewUrl: "blob:ready",
      },
    ]);

    expect(getDraftAttachments(store, draftId)).toHaveLength(2);
    expect(JSON.parse(store.getItem("omb-draft-attachments") ?? "{}")[draftId]).toEqual([
      {
        kind: "image",
        id: "ready",
        path: "/private/attachments/ready.png",
        name: "ready.png",
        size: 4,
        mime: "image/png",
      },
    ]);
  });

  it("replaces a pending image after navigation without appending a duplicate", () => {
    const store = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
    const draftId = "bot:replace:thread-replace";
    setDraftAttachments(store, draftId, [{
      kind: "image",
      id: "same-image",
      path: "",
      name: "photo.png",
      size: 3,
      mime: "image/png",
      previewUrl: "blob:photo",
      uploading: true,
    }]);

    expect(replaceDraftAttachment(draftId, "same-image", {
      kind: "image",
      id: "same-image",
      path: "/private/attachments/photo.png",
      name: "photo.png",
      size: 3,
      mime: "image/png",
      previewUrl: "blob:photo",
    })).toBe(true);
    expect(getDraftAttachments(store, draftId)).toEqual([
      expect.objectContaining({ id: "same-image", path: "/private/attachments/photo.png" }),
    ]);
    expect(replaceDraftAttachment(draftId, "missing", null)).toBe(false);
  });

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
