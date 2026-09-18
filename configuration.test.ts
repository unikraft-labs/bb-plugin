import { describe, expect, it } from "vitest";
import {
  defaultSandboxRom,
  isResolved,
  resolve,
  type SettingValues,
} from "./configuration";

function values(overrides: Partial<SettingValues> = {}): SettingValues {
  return {
    mode: "managed",
    ukcToken: "token",
    ukcMetro: "fra",
    bastionUrl: undefined,
    bastionToken: "bastion-token",
    bastionImage: "index.unikraft.io/unikraft/bb-bastion:latest",
    bastionVcpus: 1,
    bastionMemoryMb: 1024,
    sandboxImage: "debian:latest",
    sandboxRom: undefined,
    sandboxVcpus: 1,
    sandboxMemoryMb: 4096,
    sandboxExtraEnv: "{}",
    sandboxPrepare: "curl -fsSL https://claude.ai/install.sh | bash",
    sandboxPrepareTimeout: "5m",
    sandboxCooldownMs: 5000,
    sandboxTtl: "168h",
    templateEnabled: true,
    listenPort: 7443,
    ...overrides,
  };
}

describe("resolve", () => {
  it("resolves a managed configuration", () => {
    const result = resolve(values(), "0.43.1");
    expect(isResolved(result)).toBe(true);
    if (!isResolved(result)) return;
    expect(result.mode).toBe("managed");
    expect(result.sandbox.rom).toBe(defaultSandboxRom("0.43.1"));
    expect(result.sandbox.extraEnv).toEqual({});
  });

  it("reports the credentials a managed configuration lacks", () => {
    const result = resolve(
      values({ ukcToken: "  ", ukcMetro: undefined }),
      "0.43.1",
    );
    expect(result).toEqual({ missing: ["ukcToken", "ukcMetro"] });
  });

  it("requires a URL in external mode and ignores the cloud token", () => {
    const result = resolve(
      values({ mode: "external", ukcToken: undefined, ukcMetro: undefined }),
      "0.43.1",
    );
    expect(result).toEqual({ missing: ["bastionUrl"] });
  });

  it("strips trailing slashes from the bastion URL", () => {
    const result = resolve(
      values({ mode: "external", bastionUrl: "https://bastion.example///" }),
      "0.43.1",
    );
    expect(isResolved(result) && result.bastionUrl).toBe(
      "https://bastion.example",
    );
  });

  it("keeps an explicit ROM over the derived one", () => {
    const result = resolve(values({ sandboxRom: "example/rom:pinned" }), "");
    expect(isResolved(result) && result.sandbox.rom).toBe("example/rom:pinned");
  });

  it("needs a ROM when the bb version is unknown", () => {
    const result = resolve(values(), "");
    expect(result).toEqual({ missing: ["sandboxRom"] });
  });

  it("parses the sandbox environment", () => {
    const result = resolve(
      values({ sandboxExtraEnv: '{"HTTP_PROXY":"http://proxy:3128"}' }),
      "0.43.1",
    );
    expect(isResolved(result) && result.sandbox.extraEnv).toEqual({
      HTTP_PROXY: "http://proxy:3128",
    });
  });

  it("reads one prepare command per non-empty line", () => {
    const result = resolve(
      values({ sandboxPrepare: "  first  \n\n second \n  " }),
      "0.43.1",
    );
    expect(isResolved(result) && result.sandbox.prepare).toEqual([
      "first",
      "second",
    ]);
    expect(isResolved(result) && result.sandbox.prepareTimeout).toBe("5m");
  });

  it("resolves no prepare commands from an empty setting", () => {
    const result = resolve(values({ sandboxPrepare: "  \n " }), "0.43.1");
    expect(isResolved(result) && result.sandbox.prepare).toEqual([]);
  });

  it("rejects a sandbox environment that is not a string map", () => {
    expect(resolve(values({ sandboxExtraEnv: '{"A":1}' }), "0.43.1")).toEqual({
      missing: ["sandboxExtraEnv"],
    });
    expect(resolve(values({ sandboxExtraEnv: "nope" }), "0.43.1")).toEqual({
      missing: ["sandboxExtraEnv"],
    });
  });
});
