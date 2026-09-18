import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";

export const SETTING_DESCRIPTORS = {
  mode: {
    type: "select",
    label: "Mode",
    description:
      "Managed lets this plugin create and delete the bastion on Unikraft Cloud. External points it at a bastion you run yourself.",
    options: ["managed", "external"],
    default: "managed",
  },
  ukcToken: {
    type: "string",
    label: "Unikraft Cloud token",
    description: "Required in managed mode.",
    secret: true,
  },
  ukcMetro: {
    type: "string",
    label: "Unikraft Cloud metro",
    description: "The metro the bastion and every sandbox run in, such as fra.",
  },
  bastionUrl: {
    type: "string",
    label: "Bastion URL",
    description:
      "Base URL of the bastion, without the /v1 suffix. Managed mode fills this in when the bastion starts.",
  },
  bastionToken: {
    type: "string",
    label: "Bastion token",
    description:
      "Bearer token for the bastion's control API. Managed mode generates one on first use.",
    secret: true,
  },
  bastionImage: {
    type: "string",
    label: "Bastion image",
    default: "index.unikraft.io/unikraft/bb-bastion:latest",
  },
  bastionVcpus: {
    type: "number",
    label: "Bastion vCPUs",
    default: 1,
  },
  bastionMemoryMb: {
    type: "number",
    label: "Bastion memory (MiB)",
    default: 1024,
  },
  sandboxImage: {
    type: "string",
    label: "Sandbox base image",
    description: "The image must contain git.",
    default: "index.unikraft.io/unikraft/bb-sandbox-base:latest",
  },
  sandboxRom: {
    type: "string",
    label: "Sandbox ROM",
    description:
      "Leave empty to use the ROM published for the bb version this server runs.",
  },
  sandboxVcpus: {
    type: "number",
    label: "Sandbox vCPUs",
    default: 1,
  },
  sandboxMemoryMb: {
    type: "number",
    label: "Sandbox memory (MiB)",
    default: 4096,
  },
  sandboxExtraEnv: {
    type: "string",
    label: "Sandbox environment",
    description: "A JSON object of environment variables added to every sandbox.",
    experimental_multiline: true,
    default: "{}",
  },
  sandboxPrepare: {
    type: "string",
    label: "Sandbox prepare commands",
    description:
      "Shell commands, one per line, run once inside a fresh sandbox: the template seed, or a sandbox created straight from the image. Agent CLIs belong here.",
    experimental_multiline: true,
    default: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  sandboxPrepareTimeout: {
    type: "string",
    label: "Sandbox prepare timeout",
    description:
      "How long the prepare commands may run before the sandbox is given up on, as a Go duration.",
    default: "5m",
  },
  sandboxCooldownMs: {
    type: "number",
    label: "Scale-to-zero cooldown (ms)",
    default: 5000,
  },
  sandboxTtl: {
    type: "string",
    label: "Sandbox lifetime",
    description:
      "How long a stopped sandbox survives before Unikraft Cloud deletes it, as a Go duration.",
    default: "168h",
  },
  templateEnabled: {
    type: "boolean",
    label: "Warm a sandbox template",
    default: true,
  },
  listenPort: {
    type: "number",
    label: "Sandbox listen port",
    description: "The loopback port each sandbox's daemon dials inside its microVM.",
    default: 7443,
  },
} satisfies Record<string, PluginSettingDescriptor>;

export type SettingDescriptors = typeof SETTING_DESCRIPTORS;

export interface SettingValues {
  mode: string;
  ukcToken: string | undefined;
  ukcMetro: string | undefined;
  bastionUrl: string | undefined;
  bastionToken: string | undefined;
  bastionImage: string;
  bastionVcpus: number;
  bastionMemoryMb: number;
  sandboxImage: string;
  sandboxRom: string | undefined;
  sandboxVcpus: number;
  sandboxMemoryMb: number;
  sandboxExtraEnv: string;
  sandboxPrepare: string;
  sandboxPrepareTimeout: string;
  sandboxCooldownMs: number;
  sandboxTtl: string;
  templateEnabled: boolean;
  listenPort: number;
}

export interface ResolvedSandbox {
  image: string;
  rom: string;
  vcpus: number;
  memoryMb: number;
  extraEnv: Record<string, string>;
  prepare: string[];
  prepareTimeout: string;
  cooldownMs: number;
  ttl: string;
}

export interface ResolvedSettings {
  mode: "managed" | "external";
  ukcToken: string;
  ukcMetro: string;
  bastionUrl: string;
  bastionToken: string;
  bastionImage: string;
  bastionVcpus: number;
  bastionMemoryMb: number;
  sandbox: ResolvedSandbox;
  templateEnabled: boolean;
  listenPort: number;
}

export interface MissingSettings {
  missing: string[];
}

export type ResolveResult = ResolvedSettings | MissingSettings;

export const ROM_REPOSITORY = "index.unikraft.io/unikraft/bb-sandbox";

export function defaultSandboxRom(bbVersion: string): string {
  return `${ROM_REPOSITORY}:${bbVersion}`;
}

export function isResolved(result: ResolveResult): result is ResolvedSettings {
  return !("missing" in result);
}

export const SETTING_LABELS: Record<string, string> = {
  ukcToken: "Unikraft Cloud token",
  ukcMetro: "Unikraft Cloud metro",
  bastionUrl: "Bastion URL",
  bastionToken: "Bastion token",
  sandboxRom: "Sandbox ROM",
  sandboxExtraEnv: "Sandbox environment",
};

export function describeMissing(missing: string[]): string {
  const names = missing.map((key) => SETTING_LABELS[key] ?? key);
  return `Unikraft Cloud needs ${names.join(", ")} in its plugin settings.`;
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

function parseExtraEnv(raw: string): Record<string, string> | null {
  const text = raw.trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") return null;
    entries[key] = value;
  }
  return entries;
}

function parsePrepare(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function resolve(
  values: SettingValues,
  bbVersion: string,
): ResolveResult {
  const missing: string[] = [];
  const mode = values.mode === "external" ? "external" : "managed";
  const ukcToken = trimmed(values.ukcToken);
  const ukcMetro = trimmed(values.ukcMetro);
  const bastionUrl = normalizeBaseUrl(trimmed(values.bastionUrl));
  const bastionToken = trimmed(values.bastionToken);

  if (mode === "managed") {
    if (ukcToken === "") missing.push("ukcToken");
    if (ukcMetro === "") missing.push("ukcMetro");
    if (bastionToken === "") missing.push("bastionToken");
  } else {
    if (bastionUrl === "") missing.push("bastionUrl");
    if (bastionToken === "") missing.push("bastionToken");
  }

  const rom = trimmed(values.sandboxRom);
  const resolvedRom = rom === "" ? defaultSandboxRom(bbVersion) : rom;
  if (bbVersion === "" && rom === "") missing.push("sandboxRom");

  const extraEnv = parseExtraEnv(values.sandboxExtraEnv);
  if (extraEnv === null) missing.push("sandboxExtraEnv");

  if (missing.length > 0) return { missing };

  return {
    mode,
    ukcToken,
    ukcMetro,
    bastionUrl,
    bastionToken,
    bastionImage: values.bastionImage,
    bastionVcpus: values.bastionVcpus,
    bastionMemoryMb: values.bastionMemoryMb,
    sandbox: {
      image: values.sandboxImage,
      rom: resolvedRom,
      vcpus: values.sandboxVcpus,
      memoryMb: values.sandboxMemoryMb,
      extraEnv: extraEnv ?? {},
      prepare: parsePrepare(values.sandboxPrepare),
      prepareTimeout: values.sandboxPrepareTimeout,
      cooldownMs: values.sandboxCooldownMs,
      ttl: values.sandboxTtl,
    },
    templateEnabled: values.templateEnabled,
    listenPort: values.listenPort,
  };
}
