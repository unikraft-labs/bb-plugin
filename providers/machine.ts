import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BbBastionPluginApi } from "../bastion/api/index";
import type { models } from "../bastion/api/api/index.gen";
import { BastionError, unwrap } from "../bastion/client";
import { BastionRequestError } from "../bastion/transport";
import {
  MACHINE_PROVIDER_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ICON,
} from "./environment";
import { describeError, toAvailability, type ProviderStatus } from "./status";

export const MACHINE_INPUTS_SCHEMA = z
  .object({
    vcpus: z.number().int().min(1).max(16).optional(),
    memoryMb: z.number().int().min(256).max(65_536).optional(),
    image: z.string().min(1).optional(),
    ports: z.array(z.number().int().min(1).max(65_535)).max(16).optional(),
  })
  .nullish();

export type MachineInputs = z.infer<typeof MACHINE_INPUTS_SCHEMA>;

export const RESOURCE_SCHEMA = z.object({
  sandboxId: z.string(),
  instanceUuid: z.string(),
  name: z.string(),
});

export type MachineResource = z.infer<typeof RESOURCE_SCHEMA>;

const ENROLLMENT_SCHEMA = z.object({
  hostId: z.string(),
  serverUrl: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  credential: z.string(),
  expiresAt: z.union([z.string(), z.number()]),
});

export interface MachineDefaults {
  vcpus: number;
  memoryMb: number;
}

export interface MachineDeps {
  status(): ProviderStatus;
  client(): BbBastionPluginApi;
  defaults(): MachineDefaults;
}

export function toBootstrapRequest(stdin: string): models.BootstrapRequest {
  const enrollment = ENROLLMENT_SCHEMA.parse(JSON.parse(stdin));
  return {
    host_id: enrollment.hostId,
    server_url: enrollment.serverUrl,
    credential: enrollment.credential,
    expires_at:
      typeof enrollment.expiresAt === "number"
        ? new Date(enrollment.expiresAt).toISOString()
        : enrollment.expiresAt,
    ...(enrollment.headers === undefined ? {} : { headers: enrollment.headers }),
  };
}

export function isNotFound(error: unknown): boolean {
  if (error instanceof BastionError) return error.status === 404;
  if (error instanceof BastionRequestError) return error.status === 404;
  return false;
}

export function machineName(instanceName: string): string {
  const name = instanceName.trim();
  return name === ""
    ? "Unikraft Cloud sandbox"
    : `Unikraft Cloud sandbox ${name}`;
}

export function sandboxExecutor(
  client: BbBastionPluginApi,
  sandboxId: string,
): MachineExecutor {
  return {
    async exec(request) {
      let body: models.BootstrapRequest;
      try {
        body = toBootstrapRequest(request.stdin);
      } catch (error) {
        request.onOutput(`bootstrap payload rejected: ${describeError(error)}\n`);
        return { exitCode: 1 };
      }
      try {
        const result = unwrap(
          await client.sandboxes.bootstrapSandbox(sandboxId, {
            body,
            signal: request.signal,
          }),
        );
        request.onOutput(
          `enrolled ${result.host_id}; daemon pid ${result.daemon_pid}\n`,
        );
        return { exitCode: 0 };
      } catch (error) {
        request.onOutput(`bootstrap failed: ${describeError(error)}\n`);
        return { exitCode: 1 };
      }
    },
  };
}

async function deleteSandbox(
  deps: MachineDeps,
  sandboxId: string,
  signal: AbortSignal,
): Promise<{ status: "removed" } | { status: "failed"; message: string }> {
  try {
    unwrap(await deps.client().sandboxes.deleteSandbox(sandboxId, { signal }));
    return { status: "removed" };
  } catch (error) {
    if (isNotFound(error)) return { status: "removed" };
    return { status: "failed", message: describeError(error) };
  }
}

export function registerMachine(bb: BbPluginApi, deps: MachineDeps): void {
  bb.experimental_machines.register({
    id: MACHINE_PROVIDER_ID,
    displayName: PROVIDER_DISPLAY_NAME,
    description:
      "Create a Unikraft Cloud microVM for this thread; it scales to zero between turns.",
    icon: PROVIDER_ICON,
    ephemeral: true,
    inputs: MACHINE_INPUTS_SCHEMA,
    availability() {
      return toAvailability(deps.status());
    },
    async create(context) {
      try {
        const status = deps.status();
        if (status.kind !== "ready") {
          return { status: "failed", message: status.message };
        }
        const client = deps.client();
        const defaults = deps.defaults();
        const inputs: MachineInputs = context.inputs;
        context.report.step("Creating the Unikraft Cloud sandbox…");
        const sandbox = unwrap(
          await client.sandboxes.createSandbox({
            body: {
              thread_id: context.key,
              vcpus: inputs?.vcpus ?? defaults.vcpus,
              memory_mb: inputs?.memoryMb ?? defaults.memoryMb,
              ...(inputs?.image === undefined ? {} : { image: inputs.image }),
              ...(inputs?.ports === undefined ? {} : { ports: inputs.ports }),
            },
            signal: context.signal,
          }),
        );
        const resource: MachineResource = {
          sandboxId: sandbox.id,
          instanceUuid: sandbox.instance_uuid,
          name: sandbox.name,
        };
        await context.checkpoint(resource);
        context.report.step("Enrolling the sandbox with bb…");
        await bb.experimental_machines.bootstrap({
          key: context.key,
          executor: sandboxExecutor(client, sandbox.id),
          report: context.report,
          signal: context.signal,
        });
        return { status: "created", name: machineName(resource.name), resource };
      } catch (error) {
        return { status: "failed", message: describeError(error) };
      }
    },
    async reconcileCleanup(context) {
      return deleteSandbox(deps, context.key, context.signal);
    },
    async remove(context) {
      const parsed = RESOURCE_SCHEMA.safeParse(context.resource);
      if (!parsed.success) return { status: "removed" };
      return deleteSandbox(deps, parsed.data.sandboxId, context.signal);
    },
  });
}
