import type { ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";

interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
}

/** A saved choice is intentional: an unavailable provider or removed model
 * sends new bots to setup instead of silently changing their provider. */
export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
): ModelSelection {
  if (preferred) {
    const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
    if (
      instance?.snapshot.state !== "available" ||
      instance.snapshot.authenticated === false ||
      !(instance.models.default === preferred.model || instance.models.options.some((model) => model.id === preferred.model))
    ) {
      return { instanceId: "", model: "" };
    }
    return { ...preferred };
  }
  const available = instances.filter((instance) => instance.snapshot.state === "available");
  const pick = available.find((instance) => instance.driverKind === "claudeAgent") ?? available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}
