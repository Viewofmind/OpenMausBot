import type { Bot, InstanceInfo } from "@/state/store";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

/** Whether the Runs-on “This computer” control should be clickable.
 *  macOS keeps the destination available even before CUA has a grant, so
 *  the user can pick it and then approve Accessibility / Screen Recording
 *  instead of finding a grayed-out button. */
export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin";
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) {
    return "The selected provider cannot request approvals for local computer actions.";
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.";
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return "Wayland local control is currently limited to GNOME. Xorg remains available on supported desktops.";
    }
    if (!capabilities.localComputer.enabled) {
      return "Enable the local control beta and complete the Cua Driver checks first.";
    }
    return capabilities.localComputer.message ?? "Cua Driver is not ready for local control.";
  }
  if (capabilities.host.label === "Browser") {
    return "Local computer control requires the desktop app.";
  }
  return "CUA Driver is not ready for local computer control.";
}

export function linuxAutoDescription(): string {
  return "Auto reuses an existing cloud box; otherwise computer use stays off.";
}

export type BoxPanelAction = "ensure-box" | "local" | "unconfigured" | "auto-unavailable";

/** Mirror the turn router's Box choice without letting a passive panel open
 * create infrastructure. Auto may wake an existing Box. The box-native
 * Computer engine is the sole creation exception because it cannot run
 * anywhere else; explicit Cloud is always an intentional creation request. */
export function resolveBoxPanelAction({
  computer,
  driverKind,
  configured,
  hasExistingBox,
  canUseCloud,
  autoLocal,
}: {
  computer: Bot["computer"];
  driverKind: string | undefined;
  configured: boolean;
  hasExistingBox: boolean;
  canUseCloud: boolean;
  autoLocal: boolean;
}): BoxPanelAction {
  const explicitCloud = computer === "cloud";
  const boxNative = driverKind === "boxAgent";

  if (!configured) {
    if (explicitCloud || boxNative) return "unconfigured";
    return autoLocal ? "local" : "auto-unavailable";
  }
  if (canUseCloud && (hasExistingBox || explicitCloud || boxNative)) return "ensure-box";
  return autoLocal ? "local" : "auto-unavailable";
}

export function autoSelectsLocalComputer({
  platform,
  computer,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return platform !== "linux" && computer !== "cloud" && capabilitiesReady && localSelectable;
}
