import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { BotListItem } from "./Sidebar";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
});

function renderRow(candidate: Bot, archiveDisabled: boolean) {
  return renderToStaticMarkup(createElement(
    StoreProvider,
    null,
    createElement(BotListItem, {
      bot: candidate,
      density: "comfortable",
      onMenu: vi.fn(),
      onArchive: vi.fn(),
      archiveDisabled,
    }),
  ));
}

describe("BotListItem", () => {
  it("leaves the full Chief card as one selectable hit area", () => {
    const markup = renderRow(bot({ chiefOfStaff: true }), false);

    expect(markup).toContain('data-sidebar-bot-row="atlas"');
    expect(markup).not.toContain('aria-label="Archive Atlas"');
  });

  it("renders the inline Archive action only when it is available", () => {
    expect(renderRow(bot(), true)).not.toContain('aria-label="Archive Atlas"');
    expect(renderRow(bot(), false)).toContain('aria-label="Archive Atlas"');
  });
});
