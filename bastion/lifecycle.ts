import type { ResolvedSettings } from "../configuration";
import { BastionError, createBastionClient } from "./client";
import { type FetchLike } from "./transport";

export const BASTION_INSTANCE_NAME = "bb-bastion";
export const BASTION_CONFIG_ROM_NAME = "bb-bastion-config";
export const BASTION_CONFIG_MOUNT = "/etc/bb-bastion";
export const BASTION_CONFIG_FILE = "config.yaml";
export const BASTION_INTERNAL_PORT = 8080;
export const BASTION_PUBLIC_PORT = 443;
export const SANDBOX_NAME_PREFIX = "bbx-";
export const PROXY_HEARTBEAT_REWRITE_MS = 3_600_000;
export const PROXY_WAKE_TIMEOUT = "10s";
export const SWEEP_INTERVAL = "5m";

export interface UkcInstance {
  uuid: string;
  name: string;
  state: string;
  service_group?: { domains?: { fqdn?: string }[] };
}

export interface BastionInstance {
  uuid: string;
  name: string;
  state: string;
  url: string | null;
}

export interface StartResult {
  uuid: string;
  url: string;
  created: boolean;
}

export interface StopResult {
  deleted: boolean;
}

export interface LifecycleOptions {
  settings: ResolvedSettings;
  fetch?: FetchLike;
  signal?: AbortSignal;
  report?: (text: string) => void;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class UkcError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "UkcError";
    this.status = status;
  }
}

export function ukcBaseUrl(metro: string): string {
  return metro.includes("://")
    ? metro.replace(/\/+$/u, "")
    : `https://api.${metro}.unikraft.cloud`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlMap(
  entries: Record<string, string>,
  indent: string,
): string[] {
  return Object.keys(entries)
    .sort()
    .map((key) => `${indent}${key}: ${yamlString(entries[key] ?? "")}`);
}

export function renderBastionConfig(settings: ResolvedSettings): string {
  const extraEnv = yamlMap(settings.sandbox.extraEnv, "    ");
  const prepare = settings.sandbox.prepare.map(
    (command) => `    - ${yamlString(command)}`,
  );
  const lines = [
    "ukc:",
    `  metro: ${yamlString(settings.ukcMetro)}`,
    "sandbox:",
    `  image: ${yamlString(settings.sandbox.image)}`,
    `  rom: ${yamlString(settings.sandbox.rom)}`,
    `  vcpus: ${settings.sandbox.vcpus}`,
    `  memory_mb: ${settings.sandbox.memoryMb}`,
    `  listen_port: ${settings.listenPort}`,
    `  name_prefix: ${yamlString(SANDBOX_NAME_PREFIX)}`,
    `  ttl: ${yamlString(settings.sandbox.ttl)}`,
    "  scale_to_zero:",
    `    cooldown_ms: ${settings.sandbox.cooldownMs}`,
    "  extra_env:",
    ...(extraEnv.length === 0 ? ["    {}"] : extraEnv),
    ...(prepare.length === 0 ? ["  prepare: []"] : ["  prepare:", ...prepare]),
    `  prepare_timeout: ${yamlString(settings.sandbox.prepareTimeout)}`,
    "template:",
    `  enabled: ${settings.templateEnabled}`,
    "proxy:",
    `  heartbeat_rewrite_ms: ${PROXY_HEARTBEAT_REWRITE_MS}`,
    `  wake_timeout: ${yamlString(PROXY_WAKE_TIMEOUT)}`,
    "sweep:",
    `  interval: ${yamlString(SWEEP_INTERVAL)}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function buildCreateRequest(
  settings: ResolvedSettings,
): Record<string, unknown> {
  return {
    name: BASTION_INSTANCE_NAME,
    image: settings.bastionImage,
    vcpus: settings.bastionVcpus,
    memory_mb: settings.bastionMemoryMb,
    autostart: true,
    restart_policy: "always",
    env: {
      UKC_TOKEN: settings.ukcToken,
      UKC_METRO: settings.ukcMetro,
      BASTION_TOKEN: settings.bastionToken,
    },
    service_group: {
      services: [
        {
          port: BASTION_PUBLIC_PORT,
          destination_port: BASTION_INTERNAL_PORT,
          handlers: ["tls", "http"],
        },
      ],
    },
    roms: [
      {
        name: BASTION_CONFIG_ROM_NAME,
        at: BASTION_CONFIG_MOUNT,
        files: [
          {
            path: BASTION_CONFIG_FILE,
            encoding: "text",
            data: renderBastionConfig(settings),
          },
        ],
      },
    ],
  };
}

export function instanceUrl(instance: UkcInstance): string | null {
  const fqdn = instance.service_group?.domains?.[0]?.fqdn;
  if (fqdn === undefined || fqdn === "") return null;
  return `https://${fqdn.replace(/\.$/u, "")}`;
}

async function ukcCall<T>(
  options: LifecycleOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const call = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${options.settings.ukcToken}`,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  if (options.signal !== undefined) init.signal = options.signal;
  const response = await call(
    `${ukcBaseUrl(options.settings.ukcMetro)}${path}`,
    init,
  );
  const text = await response.text();
  let envelope: {
    status?: string;
    message?: string;
    data?: T;
    errors?: { status?: number }[];
  };
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    throw new UkcError(
      `Unikraft Cloud returned HTTP ${response.status} without a JSON body.`,
      response.status,
    );
  }
  if (!response.ok || envelope.status === "error") {
    throw new UkcError(
      envelope.message ?? `Unikraft Cloud returned HTTP ${response.status}.`,
      envelope.errors?.[0]?.status ?? response.status,
    );
  }
  if (envelope.data === undefined) {
    throw new UkcError("Unikraft Cloud returned no data.", null);
  }
  return envelope.data;
}

export async function findBastionInstance(
  options: LifecycleOptions,
): Promise<BastionInstance | null> {
  const data = await ukcCall<{ instances?: UkcInstance[] }>(
    options,
    "GET",
    "/v1/instances?details=true",
  );
  const instance = (data.instances ?? []).find(
    (candidate) =>
      candidate.name === BASTION_INSTANCE_NAME && candidate.state !== "deleted",
  );
  if (instance === undefined) return null;
  return {
    uuid: instance.uuid,
    name: instance.name,
    state: instance.state,
    url: instanceUrl(instance),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitUntilReady(
  options: LifecycleOptions,
  url: string,
): Promise<void> {
  const timeout = options.readyTimeoutMs ?? 180_000;
  const interval = options.pollIntervalMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;
  const client = createBastionClient(
    { bastionUrl: url, bastionToken: options.settings.bastionToken },
    options.fetch,
  );
  let waited = 0;
  let last = "The bastion did not become ready.";
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      const envelope = await client.health.getHealth();
      if (envelope.status === "success" && envelope.data?.ready === true) return;
      last = envelope.message ?? "The bastion is not ready yet.";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (waited >= timeout) break;
    await sleep(interval);
    waited += interval;
  }
  throw new BastionError(last, null);
}

export async function startBastion(
  options: LifecycleOptions,
): Promise<StartResult> {
  const { settings, report } = options;
  if (settings.mode === "external") {
    if (settings.bastionUrl === "") {
      throw new BastionError("External mode needs a bastion URL.", null);
    }
    report?.("Waiting for the bastion…");
    await waitUntilReady(options, settings.bastionUrl);
    return { uuid: "", url: settings.bastionUrl, created: false };
  }

  const existing = await findBastionInstance(options);
  let instance: BastionInstance;
  let created = false;
  if (existing === null) {
    report?.("Creating the bastion instance…");
    const data = await ukcCall<{ instances?: UkcInstance[] }>(
      options,
      "POST",
      "/v1/instances",
      buildCreateRequest(settings),
    );
    const record = data.instances?.[0];
    if (record === undefined) {
      throw new UkcError("Unikraft Cloud created no instance.", null);
    }
    instance = {
      uuid: record.uuid,
      name: record.name,
      state: record.state,
      url: instanceUrl(record),
    };
    created = true;
  } else {
    report?.("Reusing the bastion instance…");
    instance = existing;
  }

  if (instance.url === null) {
    throw new UkcError(
      "The bastion instance has no public domain; delete it and start again.",
      null,
    );
  }

  report?.("Waiting for the bastion…");
  await waitUntilReady(options, instance.url);

  if (settings.templateEnabled) {
    report?.("Warming the sandbox template…");
    const client = createBastionClient(
      { bastionUrl: instance.url, bastionToken: settings.bastionToken },
      options.fetch,
    );
    await client.template.warmTemplate({ body: {} });
  }

  return { uuid: instance.uuid, url: instance.url, created };
}

export async function stopBastion(
  options: LifecycleOptions,
): Promise<StopResult> {
  if (options.settings.mode === "external") return { deleted: false };
  const existing = await findBastionInstance(options);
  if (existing === null) return { deleted: false };
  options.report?.("Deleting the bastion instance…");
  await ukcCall<unknown>(options, "DELETE", "/v1/instances", [
    { uuid: existing.uuid },
  ]);
  return { deleted: true };
}
