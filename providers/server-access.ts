import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { toAvailability, type ProviderStatus } from "./status";

export const SERVER_ACCESS_PROVIDER_ID = "unikraft-cloud";

export interface ServerAccessDeps {
  status(): ProviderStatus;
  listenPort(): number | null;
}

export function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function registerServerAccess(
  bb: BbPluginApi,
  deps: ServerAccessDeps,
): void {
  bb.experimental_serverAccess.register({
    id: SERVER_ACCESS_PROVIDER_ID,
    displayName: "Unikraft Cloud",
    description:
      "Reach this bb server from a Unikraft Cloud sandbox over the plugin's tunnel.",
    availability() {
      const port = deps.listenPort();
      const availability = toAvailability(deps.status());
      if (port === null) return availability;
      return { ...availability, serverUrl: loopbackUrl(port) };
    },
    async acquire(context) {
      const status = deps.status();
      if (status.kind !== "ready") {
        return { status: "failed", message: status.message };
      }
      const port = deps.listenPort();
      if (port === null) {
        return {
          status: "failed",
          message: "Unikraft Cloud has no sandbox listen port configured.",
        };
      }
      return { id: context.hostId, serverUrl: loopbackUrl(port) };
    },
    async release() {},
  });
}
