import { describe, expect, it } from "vitest";

import { botListItemPointerIntent } from "./sidebar-selection";

describe("botListItemPointerIntent", () => {
  it("keeps the bot row selectable while its name is being edited", () => {
    expect(botListItemPointerIntent("click", false)).toBe("select");
  });

  it("leaves clicks inside the rename input with the editor", () => {
    expect(botListItemPointerIntent("click", true)).toBe("ignore");
  });

  it("ignores unrelated pointer events", () => {
    expect(botListItemPointerIntent("contextmenu", false)).toBe("ignore");
  });
});
