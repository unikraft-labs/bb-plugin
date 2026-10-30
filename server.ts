import { randomBytes } from "node:crypto";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BbBastionPluginApi } from "./bastion/api/index";
import type { models } from "./bastion/api/api/index.gen";
import { createBastionClient, unwrap } from "./bastion/client";
import {
  consoleInstanceUrl,
  startBastion,
  stopBastion,
  ukcOrgFromToken,
} from "./bastion/lifecycle";
import {
  describeMissing,
  isResolved,
  resolve,
  SETTING_DESCRIPTORS,
  type ResolvedSettings,
} from "./configuration";
import { registerEnvironment } from "./providers/environment";
import { isNotFound, registerMachine } from "./providers/machine";
import { registerServerAccess } from "./providers/server-access";
import { describeError, type ProviderStatus } from "./providers/status";
import { runTunnel } from "./tunnel/mux";

export const BASTION_CHANGED = "bastion-changed";

export const DISPLACED_MESSAGE =
  "Another bb server uses this bastion with the same token and took its tunnel. " +
  "A bastion serves one bb server. Start a separate bastion for this server, " +
  "or select Start bastion to take this one back.";

const sandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  instanceUuid: z.string(),
  privateFqdn: z.string(),
  state: z.string(),
  vcpus: z.number(),
  memoryMb: z.number(),
  fqdn: z.string().nullable(),
  services: z.array(z.object({ port: z.number(), url: z.string() })),
  lastActivityAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SandboxView = z.infer<typeof sandboxSchema>;

const statusSchema = z.object({
  mode: z.string(),
  configured: z.boolean(),
  missing: z.array(z.string()),
  message: z.string().nullable(),
  bastionUrl: z.string(),
  tunnelConnected: z.boolean(),
  ready: z.boolean(),
  version: z.string().nullable(),
  metro: z.string().nullable(),
  org: z.string().nullable(),
  template: z.object({ key: z.string(), state: z.string() }).nullable(),
  counts: z
    .object({
      total: z.number(),
      standby: z.number(),
      running: z.number(),
    })
    .nullable(),
  error: z.string().nullable(),
});
export type BastionStatus = z.infer<typeof statusSchema>;

const templateSchema = z.object({ key: z.string(), state: z.string() });

const settingsViewSchema = z.object({
  mode: z.string(),
  ukcMetro: z.string(),
  ukcOrg: z.string(),
  bastionUrl: z.string(),
  bastionImage: z.string(),
  bastionVcpus: z.number(),
  bastionMemoryMb: z.number(),
  sandboxImage: z.string(),
  sandboxRom: z.string(),
  sandboxVcpus: z.number(),
  sandboxMemoryMb: z.number(),
  sandboxExtraEnv: z.string(),
  sandboxPrepare: z.string(),
  sandboxPrepareTimeout: z.string(),
  sandboxCooldownMs: z.number(),
  sandboxTtl: z.string(),
  templateEnabled: z.boolean(),
  listenPort: z.number(),
  hasUkcToken: z.boolean(),
  hasBastionToken: z.boolean(),
});
export type SettingsView = z.infer<typeof settingsViewSchema>;

const settingsWriteSchema = z.object({
  mode: z.enum(["managed", "external"]).optional(),
  ukcToken: z.string().nullable().optional(),
  ukcMetro: z.string().optional(),
  ukcOrg: z.string().optional(),
  bastionUrl: z.string().optional(),
  bastionToken: z.string().nullable().optional(),
  bastionImage: z.string().optional(),
  bastionVcpus: z.number().int().min(1).optional(),
  bastionMemoryMb: z.number().int().min(128).optional(),
  sandboxImage: z.string().optional(),
  sandboxRom: z.string().optional(),
  sandboxVcpus: z.number().int().min(1).optional(),
  sandboxMemoryMb: z.number().int().min(256).optional(),
  sandboxExtraEnv: z.string().optional(),
  sandboxPrepare: z.string().optional(),
  sandboxPrepareTimeout: z.string().optional(),
  sandboxCooldownMs: z.number().int().min(0).optional(),
  sandboxTtl: z.string().optional(),
  templateEnabled: z.boolean().optional(),
  listenPort: z.number().int().min(1).max(65_535).optional(),
});
export type SettingsWrite = z.infer<typeof settingsWriteSchema>;

export const rpcContract = defineRpcContract({
  "bastion.status": { input: z.null(), output: statusSchema },
  "bastion.start": {
    input: z.null(),
    output: z.object({ url: z.string(), created: z.boolean() }),
  },
  "bastion.stop": {
    input: z.null(),
    output: z.object({ deleted: z.boolean() }),
  },
  "sandboxes.list": {
    input: z.null(),
    output: z.object({ sandboxes: z.array(sandboxSchema) }),
  },
  "sandboxes.get": {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      sandbox: sandboxSchema.nullable(),
      consoleUrl: z.string().nullable(),
    }),
  },
  "sandboxes.deleteAll": {
    input: z.null(),
    output: z.object({ deleted: z.array(z.string()) }),
  },
  "template.warm": {
    input: z.object({ force: z.boolean().optional() }),
    output: templateSchema,
  },
  "settings.read": { input: z.null(), output: settingsViewSchema },
  "settings.write": { input: settingsWriteSchema, output: settingsViewSchema },
});

function toSandboxView(sandbox: models.SandboxResponseData): SandboxView {
  return {
    id: sandbox.id,
    name: sandbox.name,
    instanceUuid: sandbox.instance_uuid,
    privateFqdn: sandbox.private_fqdn,
    state: sandbox.state,
    vcpus: sandbox.vcpus,
    memoryMb: sandbox.memory_mb,
    fqdn: sandbox.fqdn ?? null,
    services: (sandbox.services ?? []).map((service) => ({
      port: service.port,
      url: service.url,
    })),
    lastActivityAt: sandbox.last_activity_at ?? null,
    createdAt: sandbox.created_at,
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define(SETTING_DESCRIPTORS);

  let bbVersion = "";
  let resolved: ResolvedSettings | null = null;
  let missing: string[] = [];
  let health: models.HealthResponseData | null = null;
  let healthError: string | null = null;
  let tunnelConnected = false;
  let tunnelDisplaced = false;
  let restartTunnel: (() => void) | null = null;
  // Wakes a displaced tunnel; only Start and settings changes call it.
  let resumeTunnel: (() => void) | null = null;

  async function readBbVersion(): Promise<string> {
    if (bbVersion !== "") return bbVersion;
    try {
      bbVersion = (await bb.sdk.system.version()).currentVersion;
    } catch (error) {
      bb.log.warn(`could not read the bb version: ${describeError(error)}`);
    }
    return bbVersion;
  }

  async function ensureBastionToken(): Promise<void> {
    const values = await settings.get();
    if ((values.bastionToken ?? "").trim() !== "") return;
    if (values.mode === "external") return;
    await settings.experimental_set({
      bastionToken: randomBytes(32).toString("base64url"),
    });
  }

  async function reload(): Promise<void> {
    const values = await settings.get();
    const result = resolve(values, await readBbVersion());
    if (isResolved(result)) {
      resolved = result;
      missing = [];
    } else {
      resolved = null;
      missing = result.missing;
    }
  }

  function client(): BbBastionPluginApi {
    if (resolved === null) throw new Error(describeMissing(missing));
    if (resolved.bastionUrl === "") {
      throw new Error("The Unikraft Cloud bastion has not been started yet.");
    }
    return createBastionClient(resolved);
  }

  function status(): ProviderStatus {
    if (resolved === null) {
      return { kind: "setup-required", message: describeMissing(missing) };
    }
    if (resolved.bastionUrl === "") {
      return {
        kind: "setup-required",
        message:
          "Start the Unikraft Cloud bastion in Settings → Plugins → Unikraft Cloud Sandbox.",
      };
    }
    if (health === null || !health.ready) {
      return {
        kind: "unavailable",
        message: healthError ?? "The Unikraft Cloud bastion is not ready yet.",
      };
    }
    if (!tunnelConnected) {
      return {
        kind: "unavailable",
        message: tunnelDisplaced
          ? DISPLACED_MESSAGE
          : "The plugin has no tunnel to the Unikraft Cloud bastion.",
      };
    }
    return { kind: "ready" };
  }

  function publish(): void {
    try {
      bb.realtime.publish(BASTION_CHANGED, { ready: health?.ready ?? false });
    } catch (error) {
      bb.log.warn(`could not publish a signal: ${describeError(error)}`);
    }
  }

  async function refreshHealth(): Promise<void> {
    if (resolved === null || resolved.bastionUrl === "") {
      health = null;
      healthError = null;
      return;
    }
    try {
      health = unwrap(await client().health.getHealth());
      healthError = null;
    } catch (error) {
      health = null;
      healthError = describeError(error);
    }
  }

  async function rememberBastionUrl(url: string): Promise<void> {
    if (resolved !== null && resolved.bastionUrl === url) return;
    await settings.experimental_set({ bastionUrl: url });
    await reload();
  }

  function org(): string | null {
    if (resolved === null) return null;
    const name =
      resolved.ukcOrg === ""
        ? ukcOrgFromToken(resolved.ukcToken)
        : resolved.ukcOrg;
    return name === "" ? null : name;
  }

  function metro(): string | null {
    const name = health?.metro ?? resolved?.ukcMetro ?? "";
    return name === "" || name.includes("://") ? null : name;
  }

  function consoleUrl(name: string): string | null {
    const organisation = org();
    const location = metro();
    if (organisation === null || location === null || name === "") return null;
    return consoleInstanceUrl(organisation, location, name);
  }

  function currentStatus(): BastionStatus {
    const state = status();
    return {
      mode: resolved?.mode ?? "managed",
      configured: resolved !== null,
      missing,
      message: state.kind === "ready" ? null : state.message,
      bastionUrl: resolved?.bastionUrl ?? "",
      tunnelConnected,
      ready: health?.ready ?? false,
      version: health?.version ?? null,
      metro: health?.metro ?? null,
      org: org(),
      template: health === null ? null : health.template,
      counts: health === null ? null : health.sandboxes,
      error: healthError,
    };
  }

  await ensureBastionToken();
  await reload();

  registerEnvironment(bb);
  registerMachine(bb, {
    status,
    client,
    defaults: () => ({
      vcpus: resolved?.sandbox.vcpus ?? 1,
      memoryMb: resolved?.sandbox.memoryMb ?? 4096,
    }),
  });
  registerServerAccess(bb, {
    status,
    listenPort: () => resolved?.listenPort ?? null,
  });

  settings.onChange(() => {
    void (async () => {
      await reload();
      restartTunnel?.();
      resumeTunnel?.();
      await refreshHealth();
      bb.experimental_serverAccess.recheck();
      publish();
    })();
  });

  bb.background.service("tunnel", {
    async start(signal) {
      while (!signal.aborted) {
        const current = resolved;
        if (current === null || current.bastionUrl === "") {
          await wait(5_000, signal);
          continue;
        }
        const attempt = new AbortController();
        const stop = () => attempt.abort();
        restartTunnel = stop;
        signal.addEventListener("abort", stop, { once: true });
        await runTunnel({
          bastionUrl: current.bastionUrl,
          token: current.bastionToken,
          loopbackBaseUrl: bb.server.loopbackBaseUrl,
          signal: attempt.signal,
          log: {
            info: (message) => bb.log.info(message),
            warn: (message) => bb.log.warn(message),
          },
          onConnected: (connected) => {
            tunnelConnected = connected;
            if (connected) tunnelDisplaced = false;
            bb.experimental_serverAccess.recheck();
            publish();
          },
          onDisplaced: () => {
            tunnelDisplaced = true;
            bb.experimental_serverAccess.recheck();
            publish();
          },
        });
        signal.removeEventListener("abort", stop);
        restartTunnel = null;
        tunnelConnected = false;
        if (signal.aborted) break;
        if (tunnelDisplaced) {
          // Stay off the bastion until a settings change or Start bastion.
          await untilRestarted(signal);
          tunnelDisplaced = false;
        } else {
          await wait(1_000, signal);
        }
      }
    },
  });

  function untilRestarted(signal: AbortSignal): Promise<void> {
    return new Promise((done) => {
      const resume = () => {
        resumeTunnel = null;
        signal.removeEventListener("abort", resume);
        done();
      };
      resumeTunnel = resume;
      signal.addEventListener("abort", resume, { once: true });
    });
  }

  bb.background.schedule("refresh-bastion-health", "* * * * *", async () => {
    await reload();
    await refreshHealth();
    publish();
  });

  async function start(): Promise<{ url: string; created: boolean }> {
    if (resolved === null) throw new Error(describeMissing(missing));
    const result = await startBastion({
      settings: resolved,
      report: (text) => bb.log.info(text),
    });
    await rememberBastionUrl(result.url);
    restartTunnel?.();
    resumeTunnel?.();
    await refreshHealth();
    bb.experimental_serverAccess.recheck();
    publish();
    return { url: result.url, created: result.created };
  }

  async function stop(): Promise<{ deleted: boolean }> {
    if (resolved === null) throw new Error(describeMissing(missing));
    const result = await stopBastion({
      settings: resolved,
      report: (text) => bb.log.info(text),
    });
    if (resolved.mode === "managed") await rememberBastionUrl("");
    restartTunnel?.();
    health = null;
    healthError = null;
    bb.experimental_serverAccess.recheck();
    publish();
    return result;
  }

  async function listSandboxes(): Promise<SandboxView[]> {
    const data = unwrap(await client().sandboxes.listSandboxes());
    return data.sandboxes.map(toSandboxView);
  }

  async function readSandbox(threadId: string): Promise<SandboxView | null> {
    try {
      const data = unwrap(await client().sandboxes.getSandbox(threadId));
      return toSandboxView(data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function deleteAllSandboxes(): Promise<string[]> {
    const data = unwrap(await client().sandboxes.deleteAllSandboxes());
    publish();
    return data.deleted;
  }

  async function warmTemplate(force: boolean): Promise<{
    key: string;
    state: string;
  }> {
    const data = unwrap(
      await client().template.warmTemplate({ body: force ? { force } : {} }),
    );
    await refreshHealth();
    publish();
    return { key: data.key, state: data.state };
  }

  async function readSettings(): Promise<SettingsView> {
    const values = await settings.get();
    return {
      mode: values.mode,
      ukcMetro: values.ukcMetro ?? "",
      ukcOrg: values.ukcOrg ?? "",
      bastionUrl: values.bastionUrl ?? "",
      bastionImage: values.bastionImage,
      bastionVcpus: values.bastionVcpus,
      bastionMemoryMb: values.bastionMemoryMb,
      sandboxImage: values.sandboxImage,
      sandboxRom: values.sandboxRom ?? "",
      sandboxVcpus: values.sandboxVcpus,
      sandboxMemoryMb: values.sandboxMemoryMb,
      sandboxExtraEnv: values.sandboxExtraEnv,
      sandboxPrepare: values.sandboxPrepare,
      sandboxPrepareTimeout: values.sandboxPrepareTimeout,
      sandboxCooldownMs: values.sandboxCooldownMs,
      sandboxTtl: values.sandboxTtl,
      templateEnabled: values.templateEnabled,
      listenPort: values.listenPort,
      hasUkcToken: (values.ukcToken ?? "") !== "",
      hasBastionToken: (values.bastionToken ?? "") !== "",
    };
  }

  async function writeSettings(input: SettingsWrite): Promise<SettingsView> {
    const update: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      if ((key === "ukcToken" || key === "bastionToken") && value === "") {
        continue;
      }
      update[key] = value;
    }
    if (Object.keys(update).length > 0) {
      await settings.experimental_set(update);
    }
    await ensureBastionToken();
    await reload();
    await refreshHealth();
    bb.experimental_serverAccess.recheck();
    publish();
    return readSettings();
  }

  bb.rpc.register(rpcContract, {
    "bastion.status": async () => {
      await refreshHealth();
      return currentStatus();
    },
    "bastion.start": () => start(),
    "bastion.stop": () => stop(),
    "sandboxes.list": async () => ({ sandboxes: await listSandboxes() }),
    "sandboxes.get": async ({ threadId }) => {
      const sandbox = await readSandbox(threadId);
      return {
        sandbox,
        consoleUrl: sandbox === null ? null : consoleUrl(sandbox.name),
      };
    },
    "sandboxes.deleteAll": async () => ({ deleted: await deleteAllSandboxes() }),
    "template.warm": ({ force }) => warmTemplate(force ?? false),
    "settings.read": () => readSettings(),
    "settings.write": (input) => writeSettings(input),
  });

  function formatStatus(view: BastionStatus): string {
    const lines = [
      `mode          ${view.mode}`,
      `configured    ${view.configured ? "yes" : `no (${view.missing.join(", ")})`}`,
      `bastion       ${view.bastionUrl === "" ? "not started" : view.bastionUrl}`,
      `ready         ${view.ready ? "yes" : "no"}`,
      `tunnel        ${view.tunnelConnected ? "connected" : "disconnected"}`,
    ];
    if (view.version !== null) lines.push(`version       ${view.version}`);
    if (view.metro !== null) lines.push(`metro         ${view.metro}`);
    if (view.org !== null) lines.push(`org           ${view.org}`);
    if (view.template !== null) {
      lines.push(`template      ${view.template.state} (${view.template.key})`);
    }
    if (view.counts !== null) {
      lines.push(
        `sandboxes     ${view.counts.total} total, ${view.counts.running} running, ${view.counts.standby} standby`,
      );
    }
    if (view.message !== null) lines.push(`note          ${view.message}`);
    if (view.error !== null) lines.push(`error         ${view.error}`);
    return lines.join("\n");
  }

  function formatSandboxes(sandboxes: SandboxView[]): string {
    if (sandboxes.length === 0) return "No sandboxes.";
    return sandboxes
      .map((sandbox) => {
        const line = `${sandbox.state.padEnd(9)} ${sandbox.name}  ${sandbox.vcpus} vCPU  ${sandbox.memoryMb} MiB  ${sandbox.id}`;
        if (sandbox.services.length === 0) return line;
        const urls = sandbox.services
          .map((service) => `  ${service.url}`)
          .join("\n");
        return `${line}\n${urls}`;
      })
      .join("\n");
  }

  const jsonOption = {
    json: { type: "boolean", description: "Print the result as JSON" },
  } as const;

  function reply(json: boolean, value: unknown, text: string) {
    return { exitCode: 0, stdout: json ? JSON.stringify(value) : text };
  }

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PluginCliError) throw error;
      throw new PluginCliError(describeError(error));
    }
  }

  async function deleteEverySandbox(json: boolean) {
    const deleted = await deleteAllSandboxes();
    return reply(
      json,
      { deleted },
      deleted.length === 0
        ? "No sandboxes to delete."
        : `Deleted ${deleted.length} sandbox(es).`,
    );
  }

  bb.cli.register(
    defineCli({
      name: "unikraft-cloud",
      summary: "Inspect and control the Unikraft Cloud bastion and its sandboxes",
      commands: {
        status: cliCommand({
          summary: "Show the bastion's configuration and health",
          options: jsonOption,
          run: ({ options }) =>
            guarded(async () => {
              await refreshHealth();
              const view = currentStatus();
              return reply(options.json, view, formatStatus(view));
            }),
        }),
        "bastion start": cliCommand({
          summary: "Start the bastion",
          aliases: ["start"],
          options: jsonOption,
          run: ({ options }) =>
            guarded(async () => {
              const result = await start();
              return reply(
                options.json,
                result,
                `Bastion ${result.created ? "created" : "reused"} at ${result.url}.`,
              );
            }),
        }),
        "bastion stop": cliCommand({
          summary: "Stop the bastion, leaving sandboxes in standby",
          aliases: ["stop"],
          options: jsonOption,
          run: ({ options }) =>
            guarded(async () => {
              const result = await stop();
              return reply(
                options.json,
                result,
                result.deleted ? "Bastion deleted." : "No bastion to delete.",
              );
            }),
        }),
        "sandbox list": cliCommand({
          summary: "List the sandboxes the bastion manages",
          aliases: ["sandboxes"],
          options: jsonOption,
          run: ({ options }) =>
            guarded(async () => {
              const sandboxes = await listSandboxes();
              return reply(options.json, sandboxes, formatSandboxes(sandboxes));
            }),
        }),
        "sandbox show": cliCommand({
          summary: "Show the sandbox serving one thread",
          options: jsonOption,
          positionals: [
            {
              name: "thread-id",
              description: "The thread the sandbox serves",
              required: true,
            },
          ],
          run: ({ options, positionals }) =>
            guarded(async () => {
              const threadId = positionals["thread-id"];
              const sandbox = await readSandbox(threadId);
              if (sandbox === null) {
                throw new PluginCliError(`No sandbox serves thread ${threadId}.`);
              }
              const url = consoleUrl(sandbox.name);
              return reply(
                options.json,
                { ...sandbox, consoleUrl: url },
                url === null
                  ? formatSandboxes([sandbox])
                  : `${formatSandboxes([sandbox])}\n${url}`,
              );
            }),
        }),
        "sandbox delete-all": cliCommand({
          summary: "Delete every sandbox and its filesystem",
          options: {
            ...jsonOption,
            yes: {
              type: "boolean",
              description: "Confirm that every sandbox and its filesystem go",
            },
          },
          run: ({ options }) =>
            guarded(async () => {
              if (!options.yes) {
                throw new PluginCliError(
                  "This deletes every sandbox and its filesystem, including the sandboxes of live threads, and you cannot undo it.",
                  { hint: "Add --yes to confirm." },
                );
              }
              return deleteEverySandbox(options.json);
            }),
        }),
        // The old spelling never asked for --yes. It stays a hidden command
        // without the check for one release, so scripts that call it keep
        // working.
        "delete-sandboxes": cliCommand({
          summary: "Delete every sandbox and its filesystem",
          hidden: true,
          options: jsonOption,
          run: ({ options }) =>
            guarded(() => deleteEverySandbox(options.json)),
        }),
        "template warm": cliCommand({
          summary: "Build the sandbox template ahead of the first thread",
          aliases: ["warm"],
          options: {
            ...jsonOption,
            force: {
              type: "boolean",
              description: "Build the template again, even when it is ready",
            },
          },
          run: ({ options }) =>
            guarded(async () => {
              const template = await warmTemplate(options.force);
              return reply(
                options.json,
                template,
                `Template ${template.key} is ${template.state}.`,
              );
            }),
        }),
      },
    }),
  );

  void refreshHealth().then(publish);

  bb.onDispose(() => {
    restartTunnel?.();
    bb.log.info("disposed");
  });
}
