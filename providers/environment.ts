import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const MACHINE_PROVIDER_ID = "unikraft-cloud-sandbox";
export const ENVIRONMENT_PROVIDER_ID = "unikraft-cloud-sandbox";
export const PROVIDER_DISPLAY_NAME = "Unikraft Cloud";
export const PROVIDER_ICON = "Cloud";

export function registerEnvironment(bb: BbPluginApi): void {
  bb.experimental_environments.register({
    id: ENVIRONMENT_PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    description:
      "Check the project out on a fresh Unikraft Cloud sandbox that scales to zero between turns.",
    icon: PROVIDER_ICON,
    machineProviderId: MACHINE_PROVIDER_ID,
    environmentProviderId: "project-checkout",
  });
}
