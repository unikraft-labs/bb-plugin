import { describe, expect, it } from "vitest";
import type { ResolvedSettings } from "../configuration";
import {
  BASTION_INSTANCE_NAME,
  buildCreateRequest,
  findBastionInstance,
  renderBastionConfig,
  startBastion,
  stopBastion,
  consoleInstanceUrl,
  ukcBaseUrl,
  ukcOrgFromToken,
} from "./lifecycle";

function settings(overrides: Partial<ResolvedSettings> = {}): ResolvedSettings {
  return {
    mode: "managed",
    ukcToken: "ukc-token",
    ukcMetro: "fra",
    ukcOrg: "",
    bastionUrl: "",
    bastionToken: "bastion-token",
    bastionImage: "index.unikraft.io/unikraft/bb-bastion:latest",
    bastionVcpus: 1,
    bastionMemoryMb: 1024,
    sandbox: {
      image: "debian:latest",
      rom: "index.unikraft.io/unikraft/bb-sandbox:0.43.1",
      vcpus: 1,
      memoryMb: 4096,
      extraEnv: {},
      prepare: [],
      prepareTimeout: "5m",
      cooldownMs: 5000,
      ttl: "168h",
    },
    templateEnabled: true,
    listenPort: 7443,
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function router(
  routes: (call: Call) => Response | undefined,
  calls: Call[] = [],
) {
  return async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const response = routes(call);
    if (response === undefined) {
      return new Response(JSON.stringify({ status: "error", message: `no route for ${call.method} ${url}` }), { status: 404 });
    }
    return response;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INSTANCE = {
  uuid: "instance-uuid",
  name: BASTION_INSTANCE_NAME,
  state: "running",
  service_group: { domains: [{ fqdn: "bb-bastion-abc.fra0.unikraft.app." }] },
};

const HEALTH = json({
  status: "success",
  op_time_us: 1,
  data: {
    ready: true,
    version: "0.1.0",
    metro: "fra",
    template: { key: "k", state: "ready" },
    sandboxes: { total: 0, standby: 0, running: 0 },
  },
});

describe("ukcBaseUrl", () => {
  it("builds the metro endpoint", () => {
    expect(ukcBaseUrl("fra")).toBe("https://api.fra.unikraft.cloud");
  });

  it("passes an explicit endpoint through", () => {
    expect(ukcBaseUrl("http://localhost:8080/")).toBe("http://localhost:8080");
  });
});

describe("renderBastionConfig", () => {
  it("renders the keys the bastion reads and no secrets", () => {
    const yaml = renderBastionConfig(
      settings({
        sandbox: { ...settings().sandbox, extraEnv: { HTTP_PROXY: "http://p:3128" } },
      }),
    );
    expect(yaml).toContain('  metro: "fra"');
    expect(yaml).toContain('  image: "debian:latest"');
    expect(yaml).toContain("  memory_mb: 4096");
    expect(yaml).toContain("  listen_port: 7443");
    expect(yaml).toContain("    cooldown_ms: 5000");
    expect(yaml).toContain('    HTTP_PROXY: "http://p:3128"');
    expect(yaml).toContain("  enabled: true");
    expect(yaml).not.toContain("ukc-token");
    expect(yaml).not.toContain("bastion-token");
  });

  it("renders an empty environment as an empty map", () => {
    expect(renderBastionConfig(settings())).toContain("  extra_env:\n    {}");
  });

  it("renders the prepare commands as a list", () => {
    const yaml = renderBastionConfig(
      settings({
        sandbox: {
          ...settings().sandbox,
          prepare: ["curl -fsSL https://claude.ai/install.sh | bash", "echo ok"],
        },
      }),
    );
    expect(yaml).toContain(
      '  prepare:\n    - "curl -fsSL https://claude.ai/install.sh | bash"\n    - "echo ok"\n  prepare_timeout: "5m"\n',
    );
  });

  it("renders no prepare commands as an empty list", () => {
    expect(renderBastionConfig(settings())).toContain(
      '  prepare: []\n  prepare_timeout: "5m"\n',
    );
  });
});

describe("buildCreateRequest", () => {
  it("carries the credentials in the environment and the config in an inline ROM", () => {
    const request = buildCreateRequest(settings()) as Record<string, any>;
    expect(request.name).toBe(BASTION_INSTANCE_NAME);
    expect(request.restart_policy).toBe("always");
    expect(request.env).toEqual({
      UKC_TOKEN: "ukc-token",
      UKC_METRO: "fra",
      BASTION_TOKEN: "bastion-token",
    });
    expect(request.service_group.services[0]).toEqual({
      port: 443,
      destination_port: 8080,
      handlers: ["tls", "http"],
    });
    expect(request.roms[0].at).toBe("/etc/bb-bastion");
    expect(request.roms[0].files[0].path).toBe("config.yaml");
    expect(request.roms[0].files[0].encoding).toBe("text");
    expect(String(request.roms[0].files[0].data)).toContain("sandbox:");
  });
});

describe("findBastionInstance", () => {
  it("returns the instance and its URL", async () => {
    const fetchImpl = router((call) =>
      call.url.startsWith("https://api.fra.unikraft.cloud/v1/instances?")
        ? json({ status: "success", op_time_us: 1, data: { instances: [INSTANCE] } })
        : undefined,
    );
    const found = await findBastionInstance({ settings: settings(), fetch: fetchImpl });
    expect(found).toEqual({
      uuid: "instance-uuid",
      name: BASTION_INSTANCE_NAME,
      state: "running",
      url: "https://bb-bastion-abc.fra0.unikraft.app",
    });
  });

  it("ignores a deleted instance", async () => {
    const fetchImpl = router(() =>
      json({
        status: "success",
        op_time_us: 1,
        data: { instances: [{ ...INSTANCE, state: "deleted" }] },
      }),
    );
    expect(
      await findBastionInstance({ settings: settings(), fetch: fetchImpl }),
    ).toBeNull();
  });
});

describe("startBastion", () => {
  it("creates the instance, waits for health and warms the template", async () => {
    const calls: Call[] = [];
    let listed = false;
    const fetchImpl = router((call) => {
      if (call.url.includes("/v1/instances?details")) {
        const body = { status: "success", op_time_us: 1, data: { instances: listed ? [INSTANCE] : [] } };
        listed = true;
        return json(body);
      }
      if (call.url.endsWith("/v1/instances") && call.method === "POST") {
        return json({ status: "success", op_time_us: 1, data: { instances: [INSTANCE] } });
      }
      if (call.url.endsWith("/v1/health")) return HEALTH.clone();
      if (call.url.endsWith("/v1/template/warm")) {
        return json({ status: "success", op_time_us: 1, data: { key: "k", state: "ready" } });
      }
      return undefined;
    }, calls);

    const result = await startBastion({
      settings: settings(),
      fetch: fetchImpl,
      sleep: async () => {},
    });
    expect(result).toEqual({
      uuid: "instance-uuid",
      url: "https://bb-bastion-abc.fra0.unikraft.app",
      created: true,
    });
    const paths = calls.map((call) => `${call.method} ${call.url}`);
    expect(paths).toContain("POST https://api.fra.unikraft.cloud/v1/instances");
    expect(paths).toContain(
      "POST https://bb-bastion-abc.fra0.unikraft.app/v1/template/warm",
    );
  });

  it("reuses an existing instance", async () => {
    const calls: Call[] = [];
    const fetchImpl = router((call) => {
      if (call.url.includes("/v1/instances?details")) {
        return json({ status: "success", op_time_us: 1, data: { instances: [INSTANCE] } });
      }
      if (call.url.endsWith("/v1/health")) return HEALTH.clone();
      if (call.url.endsWith("/v1/template/warm")) {
        return json({ status: "success", op_time_us: 1, data: { key: "k", state: "ready" } });
      }
      return undefined;
    }, calls);
    const result = await startBastion({
      settings: settings(),
      fetch: fetchImpl,
      sleep: async () => {},
    });
    expect(result.created).toBe(false);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/instances"))).toBe(false);
  });

  it("retries health until the bastion answers", async () => {
    let attempts = 0;
    const fetchImpl = router((call) => {
      if (call.url.includes("/v1/instances?details")) {
        return json({ status: "success", op_time_us: 1, data: { instances: [INSTANCE] } });
      }
      if (call.url.endsWith("/v1/health")) {
        attempts += 1;
        return attempts < 3 ? new Response("", { status: 502 }) : HEALTH.clone();
      }
      return json({ status: "success", op_time_us: 1, data: { key: "k", state: "ready" } });
    });
    await startBastion({
      settings: settings(),
      fetch: fetchImpl,
      sleep: async () => {},
    });
    expect(attempts).toBe(3);
  });

  it("creates nothing in external mode", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(
      (call) => (call.url.endsWith("/v1/health") ? HEALTH.clone() : undefined),
      calls,
    );
    const result = await startBastion({
      settings: settings({ mode: "external", bastionUrl: "https://bastion.example" }),
      fetch: fetchImpl,
      sleep: async () => {},
    });
    expect(result).toEqual({
      uuid: "",
      url: "https://bastion.example",
      created: false,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("stopBastion", () => {
  it("deletes only the bastion instance", async () => {
    const calls: Call[] = [];
    const fetchImpl = router((call) => {
      if (call.url.includes("/v1/instances?details")) {
        return json({ status: "success", op_time_us: 1, data: { instances: [INSTANCE] } });
      }
      if (call.method === "DELETE") {
        return json({ status: "success", op_time_us: 1, data: { instances: [] } });
      }
      return undefined;
    }, calls);
    expect(await stopBastion({ settings: settings(), fetch: fetchImpl })).toEqual({
      deleted: true,
    });
    const remove = calls.find((call) => call.method === "DELETE");
    expect(remove?.url).toBe("https://api.fra.unikraft.cloud/v1/instances");
    expect(remove?.body).toEqual([{ uuid: "instance-uuid" }]);
  });

  it("reports nothing to delete when the instance is gone", async () => {
    const fetchImpl = router(() =>
      json({ status: "success", op_time_us: 1, data: { instances: [] } }),
    );
    expect(await stopBastion({ settings: settings(), fetch: fetchImpl })).toEqual({
      deleted: false,
    });
  });

  it("deletes nothing in external mode", async () => {
    const calls: Call[] = [];
    const fetchImpl = router(() => undefined, calls);
    expect(
      await stopBastion({
        settings: settings({ mode: "external", bastionUrl: "https://bastion.example" }),
        fetch: fetchImpl,
      }),
    ).toEqual({ deleted: false });
    expect(calls).toHaveLength(0);
  });
});

describe("consoleInstanceUrl", () => {
  it("addresses one instance in the console", () => {
    expect(consoleInstanceUrl("acme", "fra", "bbx-thr-1")).toBe(
      "https://console.unikraft.cloud/org/acme/instances/fra/bbx-thr-1",
    );
  });
});

describe("ukcOrgFromToken", () => {
  it("reads the organisation out of a robot token", () => {
    const token = Buffer.from(
      "robot$acme.users.kraftcloud:secret",
      "utf8",
    ).toString("base64");
    expect(ukcOrgFromToken(token)).toBe("acme");
  });

  it("accepts a token whose user is the organisation", () => {
    const token = Buffer.from("acme:secret", "utf8").toString("base64");
    expect(ukcOrgFromToken(token)).toBe("acme");
  });

  it("gives up on a token it cannot read", () => {
    expect(ukcOrgFromToken("")).toBe("");
    expect(ukcOrgFromToken("not a token")).toBe("");
  });
});
