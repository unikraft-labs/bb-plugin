import type { PluginMachineProviderInputsChange } from "@get-bb/plugin-sdk";

export interface SandboxOptionDrafts {
  vcpus: string;
  memoryMb: string;
  image: string;
  ports: string[];
}

export const EMPTY_SANDBOX_OPTIONS: SandboxOptionDrafts = {
  vcpus: "",
  memoryMb: "",
  image: "",
  ports: [],
};

export function parseSandboxOptions(value: unknown): SandboxOptionDrafts {
  if (typeof value !== "object" || value === null) {
    return EMPTY_SANDBOX_OPTIONS;
  }
  const record = value as Record<string, unknown>;
  return {
    vcpus: typeof record.vcpus === "number" ? String(record.vcpus) : "",
    memoryMb: typeof record.memoryMb === "number" ? String(record.memoryMb) : "",
    image: typeof record.image === "string" ? record.image : "",
    ports: Array.isArray(record.ports)
      ? record.ports.filter((port) => typeof port === "number").map(String)
      : [],
  };
}

function integerIn(raw: string, low: number, high: number): number | null {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < low || parsed > high) return null;
  return parsed;
}

export function submissionFor(
  drafts: SandboxOptionDrafts,
): PluginMachineProviderInputsChange {
  const value: Record<string, number | string | number[]> = {};

  if (drafts.vcpus.trim() !== "") {
    const vcpus = integerIn(drafts.vcpus, 1, 16);
    if (vcpus === null) {
      return { status: "blocked", reason: "vCPUs must be 1 to 16." };
    }
    value.vcpus = vcpus;
  }

  if (drafts.memoryMb.trim() !== "") {
    const memoryMb = integerIn(drafts.memoryMb, 256, 65_536);
    if (memoryMb === null) {
      return { status: "blocked", reason: "Memory must be 256 to 65536 MiB." };
    }
    value.memoryMb = memoryMb;
  }

  if (drafts.image.trim() !== "") value.image = drafts.image.trim();

  const ports: number[] = [];
  for (const raw of drafts.ports) {
    if (raw.trim() === "") continue;
    const port = integerIn(raw, 1, 65_535);
    if (port === null) {
      return { status: "blocked", reason: "A port must be 1 to 65535." };
    }
    if (ports.includes(port)) {
      return { status: "blocked", reason: `Port ${port} is listed twice.` };
    }
    ports.push(port);
  }
  if (ports.length > 0) value.ports = ports;

  return {
    status: "ready",
    value: Object.keys(value).length === 0 ? null : value,
  };
}
