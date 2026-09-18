import { describe, expect, it } from "vitest";
import {
  BastionError,
  controlApiUrl,
  createBastionClient,
  unwrap,
  type Envelope,
} from "./client";
import { BastionRequestError, createTransport } from "./transport";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  responder: (url: string, init: RequestInit | undefined) => Response,
  recorded: Recorded[] = [],
) {
  return async (url: string, init?: RequestInit) => {
    recorded.push({ url, init });
    return responder(url, init);
  };
}

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("controlApiUrl", () => {
  it("appends the version segment once", () => {
    expect(controlApiUrl("https://bastion.example")).toBe(
      "https://bastion.example/v1",
    );
    expect(controlApiUrl("https://bastion.example/")).toBe(
      "https://bastion.example/v1",
    );
  });
});

describe("createBastionClient", () => {
  it("calls the versioned path with a bearer token", async () => {
    const recorded: Recorded[] = [];
    const client = createBastionClient(
      { bastionUrl: "https://bastion.example/", bastionToken: "secret" },
      fakeFetch(
        () =>
          envelope({
            status: "success",
            op_time_us: 1,
            data: {
              ready: true,
              version: "0.1.0",
              metro: "fra",
              template: { key: "abc", state: "ready" },
              sandboxes: { total: 0, standby: 0, running: 0 },
            },
          }),
        recorded,
      ),
    );
    const result = unwrap(await client.health.getHealth());
    expect(result.ready).toBe(true);
    expect(recorded[0]?.url).toBe("https://bastion.example/v1/health");
    expect(
      (recorded[0]?.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer secret");
  });

  it("sends a JSON body for a create", async () => {
    const recorded: Recorded[] = [];
    const client = createBastionClient(
      { bastionUrl: "https://bastion.example", bastionToken: "secret" },
      fakeFetch(
        () =>
          envelope({
            status: "success",
            op_time_us: 1,
            data: {
              id: "thread-1",
              name: "bbx-thread-1",
              instance_uuid: "uuid",
              private_fqdn: "bbx.internal",
              state: "running",
              vcpus: 1,
              memory_mb: 4096,
              created_at: "2026-01-01T00:00:00Z",
            },
          }),
        recorded,
      ),
    );
    const sandbox = unwrap(
      await client.sandboxes.createSandbox({
        body: { thread_id: "thread-1", vcpus: 1, memory_mb: 4096 },
      }),
    );
    expect(sandbox.name).toBe("bbx-thread-1");
    expect(recorded[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({
      thread_id: "thread-1",
      vcpus: 1,
      memory_mb: 4096,
    });
  });

  it("raises the HTTP status for a rejected request", async () => {
    const client = createBastionClient(
      { bastionUrl: "https://bastion.example", bastionToken: "secret" },
      fakeFetch(() => new Response("nope", { status: 401 })),
    );
    await expect(client.health.getHealth()).rejects.toBeInstanceOf(
      BastionRequestError,
    );
  });

  it("forwards abort signals and per-call headers", async () => {
    const recorded: Recorded[] = [];
    const client = createBastionClient(
      { bastionUrl: "https://bastion.example", bastionToken: "secret" },
      fakeFetch(
        () => envelope({ status: "success", op_time_us: 1, data: { deleted: [] } }),
        recorded,
      ),
    );
    const controller = new AbortController();
    await client.sandboxes.deleteAllSandboxes({
      signal: controller.signal,
      headers: { "x-trace": "1" },
    });
    expect(recorded[0]?.init?.signal).toBe(controller.signal);
    expect(
      (recorded[0]?.init?.headers as Record<string, string>)["x-trace"],
    ).toBe("1");
  });
});

describe("unwrap", () => {
  it("returns the data of a successful envelope", () => {
    const value: Envelope<{ deleted: boolean }> = {
      status: "success",
      op_time_us: 3,
      data: { deleted: true },
    };
    expect(unwrap(value)).toEqual({ deleted: true });
  });

  it("throws the message and status of a failed envelope", () => {
    const value: Envelope<never> = {
      status: "error",
      message: "no such sandbox",
      errors: [{ status: 404 }],
      op_time_us: 3,
    };
    try {
      unwrap(value);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BastionError);
      expect((error as BastionError).message).toBe("no such sandbox");
      expect((error as BastionError).status).toBe(404);
    }
  });

  it("throws when a successful envelope carries no data", () => {
    expect(() =>
      unwrap({ status: "success", op_time_us: 1 } as Envelope<unknown>),
    ).toThrow(BastionError);
  });
});

describe("createTransport", () => {
  it("serialises query values", async () => {
    const recorded: Recorded[] = [];
    const transport = createTransport({
      baseUrl: "https://bastion.example/v1",
      token: "secret",
      fetch: fakeFetch(() => envelope({ status: "success", op_time_us: 1 }), recorded),
    });
    await transport.request({
      method: "GET",
      path: "/sandboxes",
      query: { state: ["running", "standby"], limit: 2, skip: undefined },
    });
    expect(recorded[0]?.url).toBe(
      "https://bastion.example/v1/sandboxes?state=running&state=standby&limit=2",
    );
  });

  it("yields each event of a stream", async () => {
    const transport = createTransport({
      baseUrl: "https://bastion.example/v1",
      token: "secret",
      fetch: async () =>
        new Response('data: {"n":1}\n\ndata: {"n":2}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const seen: unknown[] = [];
    for await (const event of transport.stream({
      method: "GET",
      path: "/events",
    })) {
      seen.push(event);
    }
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
