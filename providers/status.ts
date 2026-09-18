import type { PluginMachineProviderAvailability } from "@get-bb/plugin-sdk/machine-provider";

export type ProviderStatus =
  | { kind: "ready" }
  | { kind: "setup-required"; message: string }
  | { kind: "unavailable"; message: string };

export function toAvailability(
  status: ProviderStatus,
): PluginMachineProviderAvailability {
  if (status.kind === "ready") return { status: "available" };
  if (status.kind === "setup-required") {
    return { status: "setup-required", message: status.message };
  }
  return { status: "unavailable", message: status.message };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
