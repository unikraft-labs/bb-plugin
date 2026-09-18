import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { TUNNEL_SUBPROTOCOL } from "./tunnel/mux";
import plugin, { type BastionStatus, type SandboxView } from "./server";

const TOKEN = "bastion-token";

const SANDBOX = {
  id: "thread-1",
  name: "bbx-thread-1",
  instance_uuid: "instance-uuid",
  private_fqdn: "bbx-thread-1.internal",
  state: "running",
  vcpus: 1,
  memory_mb: 4096,
  created_at: "2026-01-01T00:00:00Z",
};

interface Bastion {
  url: string;
  requests: string[];
  stop: () => Promise<void>;
}

function envelope(data: unknown): string {
  return JSON.stringify({ status: "success", op_time_us: 1, data });
}

async function startBastion(): Promise<Bastion> {
  const requests: string[] = [];
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "";
    requests.push(`${request.method} ${path}`);
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (path === "/v1/health") {
      response.end(
        envelope({
          ready: true,
          version: "0.1.0",
          metro: "fra",
          template: { key: "key-1", state: "ready" },
          sandboxes: { total: 1, standby: 0, running: 1 },
        }),
      );
      return;
    }
    if (path === "/v1/sandboxes" && request.method === "GET") {
      response.end(envelope({ sandboxes: [SANDBOX] }));
      return;
    }
    if (path === "/v1/sandboxes" && request.method === "POST") {
      response.end(envelope(SANDBOX));
      return;
    }
    if (path === "/v1/sandboxes/thread-1" && request.method === "GET") {
      response.end(envelope(SANDBOX));
      return;
    }
    if (path === "/v1/sandboxes" && request.method === "DELETE") {
      response.end(envelope({ deleted: ["thread-1"] }));
      return;
    }
    if (path.endsWith("/bootstrap")) {
      response.end(envelope({ host_id: "host-abc123", daemon_pid: 42 }));
      return;
    }
    if (path === "/v1/template/warm") {
      response.end(envelope({ key: "key-1", state: "ready" }));
      return;
    }
    if (request.method === "DELETE") {
      response.end(envelope({ deleted: true }));
      return;
    }
    response.writeHead(404).end(
      JSON.stringify({ status: "error", message: "not found", op_time_us: 1 }),
    );
  };
  const server = createServer(handler);
  const wss = new WebSocketServer({
    server,
    path: "/v1/tunnel",
    handleProtocols: (protocols) =>
      protocols.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: async () => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function externalSettings(url: string): Record<string, string> {
  return {
    mode: "external",
    bastionUrl: url,
    bastionToken: TOKEN,
    sandboxRom: "index.unikraft.io/unikraft/bb-sandbox:0.43.1",
  };
}

let bastion: Bastion;
let host: FakePluginHost | null = null;

beforeEach(async () => {
  bastion = await startBastion();
});

afterEach(async () => {
  await host?.harness.lifecycle.dispose();
  host = null;
  await bastion.stop();
});

async function load(
  settings: Record<string, string> = externalSettings(bastion.url),
  extra: Parameters<typeof createFakePluginHost>[0] = {},
): Promise<FakePluginHost> {
  const created = createFakePluginHost({
    pluginId: "unikraft-cloud",
    settings,
    ...extra,
  });
  await plugin(created.bb);
  host = created;
  return created;
}

describe("plugin registration", () => {
  it("registers the settings, providers, rpc methods, cli and schedule", async () => {
    const { harness } = await load();
    const registrations = harness.inspection.registrations;
    expect(Object.keys(registrations.settingsDescriptors)).toContain("ukcToken");
    expect([...registrations.machineProviders.keys()]).toEqual([
      "unikraft-cloud-sandbox",
    ]);
    expect([...registrations.environmentCompositions.keys()]).toContain(
      "unikraft-cloud-sandbox",
    );
    expect([...registrations.serverAccessProviders.keys()]).toEqual([
      "unikraft-cloud",
    ]);
    expect(registrations.rpcMethods.sort()).toEqual([
      "bastion.start",
      "bastion.status",
      "bastion.stop",
      "sandboxes.deleteAll",
      "sandboxes.get",
      "sandboxes.list",
      "settings.read",
      "settings.write",
      "template.warm",
    ]);
    expect(registrations.cli?.name).toBe("unikraft-cloud");
    expect(registrations.schedules.map((entry) => entry.name)).toContain(
      "refresh-bastion-health",
    );
    expect(registrations.services.map((entry) => entry.name)).toContain("tunnel");
  });

  it("generates a bastion token in managed mode", async () => {
    const { harness } = await load({ mode: "managed" });
    const status = (await harness.behavior.callRpc(
      "bastion.status",
      null,
    )) as BastionStatus;
    expect(status.missing).not.toContain("bastionToken");
    expect(status.missing).toEqual(["ukcToken", "ukcMetro", "sandboxRom"]);
  });
});

describe("bastion.status", () => {
  it("reports the bastion's health", async () => {
    const { harness } = await load();
    const status = (await harness.behavior.callRpc(
      "bastion.status",
      null,
    )) as BastionStatus;
    expect(status.configured).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.metro).toBe("fra");
    expect(status.template).toEqual({ key: "key-1", state: "ready" });
    expect(status.counts).toEqual({ total: 1, standby: 0, running: 1 });
  });

  it("reports what an unconfigured plugin still needs", async () => {
    const { harness } = await load({ mode: "external" });
    const status = (await harness.behavior.callRpc(
      "bastion.status",
      null,
    )) as BastionStatus;
    expect(status.configured).toBe(false);
    expect(status.missing).toContain("bastionUrl");
    expect(status.message).toContain("Bastion URL");
  });

  it("leaves the machine provider setup-required until it is configured", async () => {
    const { harness } = await load({ mode: "external" });
    const provider = harness.inspection.registrations.machineProviders.get(
      "unikraft-cloud-sandbox",
    );
    expect(await provider?.availability?.()).toEqual({
      status: "setup-required",
      message: expect.stringContaining("Bastion URL"),
    });
  });
});

describe("sandbox rpc", () => {
  it("lists sandboxes in the app's shape", async () => {
    const { harness } = await load();
    const result = (await harness.behavior.callRpc("sandboxes.list", null)) as {
      sandboxes: SandboxView[];
    };
    expect(result.sandboxes).toEqual([
      {
        id: "thread-1",
        name: "bbx-thread-1",
        instanceUuid: "instance-uuid",
        privateFqdn: "bbx-thread-1.internal",
        state: "running",
        vcpus: 1,
        memoryMb: 4096,
        lastActivityAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("describes one thread's sandbox", async () => {
    const { harness } = await load();
    const result = (await harness.behavior.callRpc("sandboxes.get", {
      threadId: "thread-1",
    })) as { sandbox: SandboxView | null; consoleUrl: string | null };
    expect(result.sandbox).toMatchObject({
      name: "bbx-thread-1",
      state: "running",
    });
    expect(result.consoleUrl).toBeNull();
  });

  it("links the sandbox to the console once the organisation is known", async () => {
    const { harness } = await load({
      ...externalSettings(bastion.url),
      ukcOrg: "acme",
    });
    const result = (await harness.behavior.callRpc("sandboxes.get", {
      threadId: "thread-1",
    })) as { consoleUrl: string | null };
    expect(result.consoleUrl).toBe(
      "https://console.unikraft.cloud/org/acme/instances/fra/bbx-thread-1",
    );
  });

  it("reads the organisation out of the cloud token", async () => {
    const { harness } = await load({
      ...externalSettings(bastion.url),
      ukcToken: Buffer.from("robot$acme.users.kraftcloud:secret").toString(
        "base64",
      ),
    });
    const status = (await harness.behavior.callRpc(
      "bastion.status",
      null,
    )) as BastionStatus;
    expect(status.org).toBe("acme");
  });

  it("reports no sandbox for an unknown thread", async () => {
    const { harness } = await load();
    expect(
      await harness.behavior.callRpc("sandboxes.get", { threadId: "thread-2" }),
    ).toEqual({ sandbox: null, consoleUrl: null });
  });

  it("deletes every sandbox", async () => {
    const { harness } = await load();
    expect(await harness.behavior.callRpc("sandboxes.deleteAll", null)).toEqual({
      deleted: ["thread-1"],
    });
  });

  it("warms the template", async () => {
    const { harness } = await load();
    expect(await harness.behavior.callRpc("template.warm", { force: true })).toEqual(
      { key: "key-1", state: "ready" },
    );
  });

  it("refuses a sandbox call before the bastion is known", async () => {
    const { harness } = await load({ mode: "external" });
    await expect(
      harness.behavior.callRpc("sandboxes.list", null),
    ).rejects.toThrow(/Bastion URL/u);
  });
});

describe("cli", () => {
  it("mirrors the status", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout) as BastionStatus).toMatchObject({
      configured: true,
      ready: true,
    });
  });

  it("mirrors the sandbox list", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["sandboxes"]);
    expect(result.stdout).toContain("bbx-thread-1");
  });

  it("mirrors one thread's sandbox", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["sandbox", "thread-1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("running");
  });

  it("reports a thread without a sandbox", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["sandbox", "thread-2"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("thread-2");
  });

  it("prints usage without a command", async () => {
    const { harness } = await load();
    expect((await harness.behavior.runCli([])).stdout).toContain(
      "bb unikraft-cloud status",
    );
  });

  it("reports a failure on stderr", async () => {
    const { harness } = await load({ mode: "external" });
    const result = await harness.behavior.runCli(["sandboxes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Bastion URL");
  });
});

describe("machine provider", () => {
  it("creates a sandbox, checkpoints it and enrolls its host", async () => {
    const enrollment = JSON.stringify({
      hostId: "host-abc123",
      serverUrl: "http://127.0.0.1:7443",
      credential: "secret",
      expiresAt: "2026-01-01T00:00:00Z",
    });
    const output: string[] = [];
    const { harness } = await load(externalSettings(bastion.url), {
      machineBootstrap: {
        async bootstrap(request) {
          const result = await request.executor.exec({
            command: ["bb", "machine", "enroll"],
            timeoutMs: 60_000,
            signal: request.signal,
            stdin: enrollment,
            onOutput: (chunk) => output.push(chunk),
          });
          expect(result.exitCode).toBe(0);
          return { hostId: "host-abc123" };
        },
      },
    });

    const service = harness.behavior.runService("tunnel");
    const deadline = Date.now() + 5_000;
    let status = (await harness.behavior.callRpc(
      "bastion.status",
      null,
    )) as BastionStatus;
    while (!status.tunnelConnected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = (await harness.behavior.callRpc(
        "bastion.status",
        null,
      )) as BastionStatus;
    }
    expect(status.tunnelConnected).toBe(true);

    const provider = harness.inspection.registrations.machineProviders.get(
      "unikraft-cloud-sandbox",
    );
    expect(await provider?.availability?.()).toEqual({ status: "available" });

    const checkpoints: unknown[] = [];
    const steps: string[] = [];
    const result = await provider?.create({
      key: "thread-1",
      attempt: 1,
      inputs: { vcpus: 2, memoryMb: 8192 },
      checkpoint: async (resource) => {
        checkpoints.push(resource);
      },
      report: {
        step: (text: string) => steps.push(text),
        log: () => {},
      },
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      status: "created",
      name: "Unikraft Cloud sandbox bbx-thread-1",
      resource: {
        sandboxId: "thread-1",
        instanceUuid: "instance-uuid",
        name: "bbx-thread-1",
      },
    });
    expect(checkpoints).toHaveLength(1);
    expect(steps[0]).toContain("Creating");
    expect(output.join("")).toContain("daemon pid 42");
    expect(bastion.requests).toContain("POST /v1/sandboxes/thread-1/bootstrap");

    service.controller.abort();
    await service.done;
  });

  it("removes a sandbox by its resource", async () => {
    const { harness } = await load();
    const provider = harness.inspection.registrations.machineProviders.get(
      "unikraft-cloud-sandbox",
    );
    expect(
      await provider?.remove({
        hostId: "host-1",
        resource: {
          sandboxId: "thread-1",
          instanceUuid: "instance-uuid",
          name: "bbx-thread-1",
        },
        report: { step: () => {}, log: () => {} },
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "removed" });
    expect(bastion.requests).toContain("DELETE /v1/sandboxes/thread-1");
  });

  it("treats an unknown sandbox as already removed", async () => {
    const { harness } = await load();
    const provider = harness.inspection.registrations.machineProviders.get(
      "unikraft-cloud-sandbox",
    );
    expect(
      await provider?.reconcileCleanup({
        key: "missing/sandbox",
        report: { step: () => {}, log: () => {} },
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "removed" });
  });
});

describe("server access provider", () => {
  it("grants the sandbox loopback URL", async () => {
    const { harness } = await load();
    const provider =
      harness.inspection.registrations.serverAccessProviders.get(
        "unikraft-cloud",
      );
    const availability = await provider?.availability();
    expect(availability?.serverUrl).toBe("http://127.0.0.1:7443");
    expect(
      await provider?.acquire({
        key: "thread-1",
        hostId: "host-1",
        signal: new AbortController().signal,
      }),
    ).toEqual({ status: "failed", message: expect.any(String) });
  });
});

describe("settings rpc", () => {
  it("reads values and hides the secrets themselves", async () => {
    const { harness } = await load();
    const view = (await harness.behavior.callRpc(
      "settings.read",
      null,
    )) as Record<string, unknown>;
    expect(view).toMatchObject({
      mode: "external",
      bastionUrl: bastion.url,
      hasBastionToken: true,
      hasUkcToken: false,
      sandboxVcpus: 1,
      sandboxMemoryMb: 4096,
      listenPort: 7443,
    });
    expect(Object.keys(view)).not.toContain("bastionToken");
  });

  it("writes values and keeps an empty secret unchanged", async () => {
    const { harness } = await load();
    const view = (await harness.behavior.callRpc("settings.write", {
      sandboxVcpus: 4,
      sandboxImage: "ubuntu:latest",
      bastionToken: "",
    })) as Record<string, unknown>;
    expect(view).toMatchObject({
      sandboxVcpus: 4,
      sandboxImage: "ubuntu:latest",
      hasBastionToken: true,
    });
  });

  it("refuses a value the descriptor does not allow", async () => {
    const { harness } = await load();
    await expect(
      harness.behavior.callRpc("settings.write", { listenPort: 0 }),
    ).rejects.toThrow();
  });
});
