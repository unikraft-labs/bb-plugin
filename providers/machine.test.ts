import { describe, expect, it } from "vitest";
import type { BbBastionPluginApi } from "../bastion/api/index";
import { BastionError } from "../bastion/client";
import {
  isNotFound,
  machineName,
  sandboxExecutor,
  toBootstrapRequest,
} from "./machine";

describe("toBootstrapRequest", () => {
  it("maps the enrollment payload to the contract's field names", () => {
    expect(
      toBootstrapRequest(
        JSON.stringify({
          hostId: "host-1",
          serverUrl: "http://127.0.0.1:7443",
          headers: { "x-bb-enrollment": "1" },
          credential: "secret",
          expiresAt: "2026-01-01T00:00:00Z",
        }),
      ),
    ).toEqual({
      host_id: "host-1",
      server_url: "http://127.0.0.1:7443",
      headers: { "x-bb-enrollment": "1" },
      credential: "secret",
      expires_at: "2026-01-01T00:00:00Z",
    });
  });

  it("omits absent headers", () => {
    const request = toBootstrapRequest(
      JSON.stringify({
        hostId: "host-1",
        serverUrl: "http://127.0.0.1:7443",
        credential: "secret",
        expiresAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect("headers" in request).toBe(false);
  });

  it("rejects a payload that is not an enrollment", () => {
    expect(() => toBootstrapRequest("{}")).toThrow();
  });
});

describe("isNotFound", () => {
  it("recognises a missing sandbox", () => {
    expect(isNotFound(new BastionError("gone", 404))).toBe(true);
    expect(isNotFound(new BastionError("boom", 500))).toBe(false);
    expect(isNotFound(new Error("boom"))).toBe(false);
  });
});

describe("machineName", () => {
  it("ends with the tail of the host id", () => {
    expect(machineName("host_ABC-123456")).toBe("Unikraft Cloud sandbox 123456");
  });
});

function fakeClient(
  bootstrap: (id: string, body: unknown) => unknown,
): BbBastionPluginApi {
  return {
    sandboxes: {
      bootstrapSandbox: async (id: string, params: { body: unknown }) =>
        bootstrap(id, params.body),
    },
  } as unknown as BbBastionPluginApi;
}

function execRequest(stdin: string, output: string[]) {
  return {
    command: ["bb", "machine", "enroll"],
    timeoutMs: 1000,
    signal: new AbortController().signal,
    stdin,
    onOutput: (chunk: string) => output.push(chunk),
  };
}

const ENROLLMENT = JSON.stringify({
  hostId: "host-1",
  serverUrl: "http://127.0.0.1:7443",
  credential: "secret",
  expiresAt: "2026-01-01T00:00:00Z",
});

describe("sandboxExecutor", () => {
  it("forwards the payload to the sandbox and succeeds", async () => {
    const seen: { id: string; body: unknown }[] = [];
    const executor = sandboxExecutor(
      fakeClient((id, body) => {
        seen.push({ id, body });
        return {
          status: "success",
          op_time_us: 1,
          data: { host_id: "host-1", daemon_pid: 42 },
        };
      }),
      "thread-1",
    );
    const output: string[] = [];
    expect(await executor.exec(execRequest(ENROLLMENT, output))).toEqual({
      exitCode: 0,
    });
    expect(seen[0]?.id).toBe("thread-1");
    expect(seen[0]?.body).toMatchObject({ host_id: "host-1" });
    expect(output.join("")).toContain("daemon pid 42");
  });

  it("reports a rejected payload without throwing", async () => {
    const executor = sandboxExecutor(
      fakeClient(() => {
        throw new Error("never reached");
      }),
      "thread-1",
    );
    const output: string[] = [];
    expect(await executor.exec(execRequest("not json", output))).toEqual({
      exitCode: 1,
    });
    expect(output.join("")).toContain("bootstrap payload rejected");
  });

  it("reports a bastion failure without throwing", async () => {
    const executor = sandboxExecutor(
      fakeClient(() => ({
        status: "error",
        message: "the sandbox is gone",
        op_time_us: 1,
      })),
      "thread-1",
    );
    const output: string[] = [];
    expect(await executor.exec(execRequest(ENROLLMENT, output))).toEqual({
      exitCode: 1,
    });
    expect(output.join("")).toContain("the sandbox is gone");
  });
});

it("toBootstrapRequest accepts an epoch-millisecond expiry", () => {
  const request = toBootstrapRequest(
    JSON.stringify({
      hostId: "host_1",
      serverUrl: "https://bb.example",
      credential: "cred",
      expiresAt: 1767225600000,
    }),
  );
  expect(request.expires_at).toBe("2026-01-01T00:00:00.000Z");
});
