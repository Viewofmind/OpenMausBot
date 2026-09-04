import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CloudComputersCard,
  LocalVmInventoryCard,
  VpsComputersCard,
  cloudComputerInventoryState,
  localVmInventoryState,
  reconcileCloudInventorySnapshot,
  vpsComputerInventoryState,
  vpsComputerShortId,
  type CloudComputerInventoryInstance,
  type LocalVmInventoryInstance,
  type VpsComputerInventoryInstance,
} from "./LocalComputerSection";

const cloudVm: LocalVmInventoryInstance = {
  botId: "cloud-bot",
  name: "Research",
  destination: "cloud",
  container: "running",
  ready: true,
  problem: null,
  inUse: false,
};

const ownedCloudComputer: CloudComputerInventoryInstance = {
  boxId: "provider-id-must-not-render",
  name: "ogb-current0-a1b2c3",
  state: "ready",
  ownerBotId: "current-owner",
  ownerName: "Research",
  orphaned: false,
  inUse: false,
};

describe("Local VM inventory UI", () => {
  it("shows capacity, current destinations, health, and an in-use deletion guard", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [
        cloudVm,
        {
          botId: "off-bot",
          name: "Archive",
          destination: "off",
          container: "stopped",
          ready: false,
          problem: "This desktop image cannot safely resume; recreate the Local VM",
          inUse: true,
        },
      ],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("2/4 created");
    expect(markup).toContain("Current destination: Cloud");
    expect(markup).toContain("Current destination: Off");
    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s turn before deleting its desktop.");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).not.toMatch(/viewer_url|workspace_path|password=/);
  });

  it("keeps state labels honest", () => {
    expect(localVmInventoryState(cloudVm)).toBe("Running");
    expect(localVmInventoryState({ ...cloudVm, ready: false })).toBe("Needs attention");
    expect(localVmInventoryState({ ...cloudVm, container: "stopped", ready: false })).toBe("Stopped");
    expect(localVmInventoryState({ ...cloudVm, inUse: true })).toBe("In use");
  });

  it("does not claim there are no VMs when the runtime cannot be inspected", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [],
      maxInstances: 4,
      loading: false,
      deletingBotId: null,
      error: null,
      unavailableReason: "Start docker first",
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(markup).toContain("Inventory unavailable");
    expect(markup).toContain("Start docker first");
    expect(markup).not.toContain("No per-bot desktops have been created");
  });

  it("disables deletion while refreshing an existing inventory", () => {
    const markup = renderToStaticMarkup(createElement(LocalVmInventoryCard, {
      instances: [cloudVm],
      maxInstances: 4,
      loading: true,
      deletingBotId: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onDelete: vi.fn(),
    }));

    // Refresh and Delete cannot race one another.
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("cloud computer inventory UI", () => {
  const renderCard = (overrides: Partial<Parameters<typeof CloudComputersCard>[0]> = {}) =>
    renderToStaticMarkup(createElement(CloudComputersCard, {
      instances: [],
      configured: true,
      loading: false,
      pending: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onSleep: vi.fn(),
      onDelete: vi.fn(),
      ...overrides,
    }));

  it("shows owners, orphans, lifecycle state and only the sanitized machine name", () => {
    const markup = renderCard({
      instances: [
        ownedCloudComputer,
        {
          boxId: "another-provider-id",
          name: "ogb-orphaned-abcdef",
          state: "archived",
          ownerBotId: null,
          ownerName: null,
          orphaned: true,
          inUse: false,
        },
      ],
    });

    expect(markup).toContain("Research");
    expect(markup).toContain("Owned by this bot");
    expect(markup).toContain("Orphaned computer");
    expect(markup).toContain("Its bot no longer exists");
    expect(markup).toContain("Running");
    expect(markup).toContain("Sleeping");
    expect(markup).toContain("ogb-current0-a1b2c3");
    expect(markup).not.toMatch(/provider-id-must-not-render|another-provider-id|desktopUrl|password|token=/);
  });

  it("disables destructive actions while the owner is working", () => {
    const markup = renderCard({ instances: [{ ...ownedCloudComputer, inUse: true }] });

    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s work before changing its computer.");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("disables lifecycle actions while refreshing an existing inventory", () => {
    const markup = renderCard({ instances: [ownedCloudComputer], loading: true });

    // Refresh, Sleep, and Delete all wait for one authoritative snapshot.
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
  });

  it("keeps disconnected, unavailable, and empty states distinct", () => {
    const disconnected = renderCard({ configured: false });
    expect(disconnected).toContain("Box is not connected");
    expect(disconnected).not.toContain("No OpenMaus-managed cloud computers found");

    const unavailable = renderCard({ unavailableReason: "ascii.dev is unavailable" });
    expect(unavailable).toContain("ascii.dev is unavailable");
    expect(unavailable).not.toContain("No OpenMaus-managed cloud computers found");

    const endpointFailure = renderCard({ configured: null, unavailableReason: "Computer inventory could not load" });
    expect(endpointFailure).toContain("Computer inventory could not load");
    expect(endpointFailure).not.toContain("Box is not connected");

    const empty = renderCard();
    expect(empty).toContain("No OpenMaus-managed cloud computers found");
  });

  it("uses honest state labels", () => {
    expect(cloudComputerInventoryState(ownedCloudComputer)).toBe("Running");
    expect(cloudComputerInventoryState({ ...ownedCloudComputer, state: "archived" })).toBe("Sleeping");
    expect(cloudComputerInventoryState({ ...ownedCloudComputer, state: "archiving" })).toBe("Going to sleep");
    expect(cloudComputerInventoryState({ ...ownedCloudComputer, state: "provisioning" })).toBe("Starting");
    expect(cloudComputerInventoryState({ ...ownedCloudComputer, state: "unknown" })).toBe("Needs attention");
    expect(cloudComputerInventoryState({ ...ownedCloudComputer, inUse: true })).toBe("In use");
  });

  it("does not let an eventually-consistent list resurrect a deleted computer", () => {
    const first = reconcileCloudInventorySnapshot(
      [ownedCloudComputer],
      [ownedCloudComputer],
      { [ownedCloudComputer.boxId]: "deleted" },
    );
    expect(first.instances).toEqual([]);
    expect(first.overrides).toEqual({ [ownedCloudComputer.boxId]: "deleted" });

    const later = reconcileCloudInventorySnapshot(
      [ownedCloudComputer],
      first.instances,
      first.overrides,
    );
    expect(later.instances).toEqual([]);
  });

  it("keeps a successful sleep visible until LIST reaches a sleeping state", () => {
    const stale = reconcileCloudInventorySnapshot(
      [{ ...ownedCloudComputer, state: "running" }],
      [ownedCloudComputer],
      { [ownedCloudComputer.boxId]: "sleeping" },
    );
    expect(stale.instances[0]?.state).toBe("archived");
    expect(stale.overrides).toEqual({ [ownedCloudComputer.boxId]: "sleeping" });

    const missing = reconcileCloudInventorySnapshot([], stale.instances, stale.overrides);
    expect(missing.instances[0]?.state).toBe("archived");
    expect(missing.overrides).toEqual(stale.overrides);

    const settled = reconcileCloudInventorySnapshot(
      [{ ...ownedCloudComputer, state: "stopped" }],
      missing.instances,
      missing.overrides,
    );
    expect(settled.instances[0]?.state).toBe("stopped");
    expect(settled.overrides).toEqual({});
  });

  it("announces cloud loading and action errors", () => {
    const loading = renderCard({ loading: true });
    expect(loading).toContain('role="status"');
    expect(loading).toContain('aria-busy="true"');

    const failed = renderCard({ error: "Could not delete this computer" });
    expect(failed).toContain('role="alert"');
  });
});

describe("VPS computer inventory UI", () => {
  const ownedVps: VpsComputerInventoryInstance = {
    name: "openmausbot-vps-current-123456abcdef",
    state: "running",
    ownerBotId: "current-owner",
    ownerName: "Research",
    orphaned: false,
    inUse: false,
  };
  const renderCard = (overrides: Partial<Parameters<typeof VpsComputersCard>[0]> = {}) =>
    renderToStaticMarkup(createElement(VpsComputersCard, {
      instances: [],
      configured: true,
      sshAlias: "production-vps",
      loading: false,
      removingName: null,
      error: null,
      unavailableReason: null,
      onRefresh: vi.fn(),
      onRemove: vi.fn(),
      ...overrides,
    }));

  it("shows the configured host, owners, orphans, and status without raw container details", () => {
    const orphanName = "openmausbot-vps-deleted-abcdef123456";
    const markup = renderCard({
      instances: [
        ownedVps,
        {
          name: orphanName,
          state: "exited",
          ownerBotId: null,
          ownerName: null,
          orphaned: true,
          inUse: false,
        },
      ],
    });

    expect(markup).toContain("SSH host: production-vps");
    expect(markup).toContain("Research");
    expect(markup).toContain("Owned by this bot");
    expect(markup).toContain("Orphaned VPS computer · ID ef123456");
    expect(markup).toContain("Its bot no longer exists");
    expect(markup).toContain("Running");
    expect(markup).toContain("Stopped");
    expect(markup).not.toMatch(new RegExp(`${ownedVps.name}|${orphanName}|containerId|VNC_PW|password`));
  });

  it("derives a stable identifier without exposing the bot-derived container name", () => {
    expect(vpsComputerShortId("openmausbot-vps-deleted-abcdef123456")).toBe("ef123456");
    expect(vpsComputerShortId("unexpected-provider-name")).toBe("unknown");
  });

  it("disables removal while the owner is working", () => {
    const markup = renderCard({ instances: [{ ...ownedVps, inUse: true }] });

    expect(markup).toContain("In use");
    expect(markup).toContain("Stop this bot&#x27;s work before removing its VPS computer.");
    expect(markup).toContain("disabled=\"\"");
  });

  it("disables removal while refreshing an existing inventory", () => {
    const markup = renderCard({ instances: [ownedVps], loading: true });

    // Refresh and Remove cannot race one another.
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("keeps disconnected, unavailable, and empty states distinct", () => {
    expect(renderCard({ configured: false, sshAlias: null })).toContain("VPS is not configured");
    expect(renderCard({ unavailableReason: "SSH host cannot be reached" })).toContain("SSH host cannot be reached");
    expect(renderCard()).toContain("No OpenMaus-managed VPS computers found");
  });

  it("uses honest status labels", () => {
    expect(vpsComputerInventoryState(ownedVps)).toBe("Running");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "exited" })).toBe("Stopped");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "paused" })).toBe("Paused");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "restarting" })).toBe("Restarting");
    expect(vpsComputerInventoryState({ ...ownedVps, state: "dead" })).toBe("Needs attention");
    expect(vpsComputerInventoryState({ ...ownedVps, inUse: true })).toBe("In use");
  });
});
