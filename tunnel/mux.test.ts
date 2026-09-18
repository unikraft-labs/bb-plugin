import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  decodeFrame,
  encodeFrame,
  encodeWindow,
  OP_CLOSE,
  OP_DATA,
  OP_OPEN,
  OP_PING,
  OP_PONG,
  OP_WINDOW,
  runTunnel,
  TUNNEL_SUBPROTOCOL,
  TunnelProtocolError,
  tunnelUrl,
  parseTarget,
  windowIncrement,
  WINDOW_THRESHOLD,
} from "./mux";

interface Vector {
  name: string;
  hex: string;
  stream_id: number;
  op: string;
  payload_hex: string;
  increment?: number;
  reason?: string;
}

interface Vectors {
  subprotocol: string;
  initial_window: number;
  max_data_payload: number;
  frames: Vector[];
  invalid: { name: string; hex: string; error: string }[];
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./testdata/vectors.json", import.meta.url)),
    "utf8",
  ),
) as Vectors;

const OP_CODES: Record<string, number> = {
  OPEN: OP_OPEN,
  DATA: OP_DATA,
  CLOSE: OP_CLOSE,
  WINDOW: OP_WINDOW,
  PING: OP_PING,
  PONG: OP_PONG,
};

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("frame vectors", () => {
  it("agrees with the shared constants", () => {
    expect(vectors.subprotocol).toBe(TUNNEL_SUBPROTOCOL);
    expect(vectors.max_data_payload).toBe(65_536);
  });

  for (const vector of vectors.frames) {
    it(`decodes ${vector.name}`, () => {
      const frame = decodeFrame(fromHex(vector.hex));
      expect(frame.streamId).toBe(vector.stream_id);
      expect(frame.op).toBe(OP_CODES[vector.op]);
      expect(toHex(frame.payload)).toBe(vector.payload_hex);
      if (vector.increment !== undefined) {
        expect(windowIncrement(frame)).toBe(vector.increment);
      }
      if (vector.reason !== undefined) {
        expect(Buffer.from(frame.payload).toString("utf8")).toBe(vector.reason);
      }
    });

    it(`encodes ${vector.name}`, () => {
      const op = OP_CODES[vector.op] as number;
      const encoded =
        vector.increment === undefined
          ? encodeFrame(vector.stream_id, op, fromHex(vector.payload_hex))
          : encodeWindow(vector.stream_id, vector.increment);
      expect(toHex(encoded)).toBe(vector.hex);
    });
  }

  for (const vector of vectors.invalid) {
    it(`refuses ${vector.name}`, () => {
      expect(() => decodeFrame(fromHex(vector.hex))).toThrow(
        TunnelProtocolError,
      );
    });
  }
});

describe("tunnelUrl", () => {
  it("upgrades the scheme and appends the path", () => {
    expect(tunnelUrl("https://bastion.example/")).toBe(
      "wss://bastion.example/v1/tunnel",
    );
    expect(tunnelUrl("http://127.0.0.1:8080")).toBe(
      "ws://127.0.0.1:8080/v1/tunnel",
    );
  });
});

describe("parseTarget", () => {
  it("defaults the port to the scheme", () => {
    expect(parseTarget("http://127.0.0.1:38886")).toEqual({
      host: "127.0.0.1",
      port: 38886,
      tls: false,
    });
    expect(parseTarget("https://example.test")).toEqual({
      host: "example.test",
      port: 443,
      tls: true,
    });
  });
});

interface Harness {
  bastionUrl: string;
  loopbackBaseUrl: string;
  next: () => Promise<WebSocket>;
  stop: () => Promise<void>;
}

const started: Harness[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function harness(body: string): Promise<Harness> {
  const app = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": String(Buffer.byteLength(body)),
      "x-path": request.url ?? "",
    });
    response.end(body);
  });
  const appPort = await listen(app);

  const bastion = createServer();
  const sockets: WebSocket[] = [];
  const waiters: ((socket: WebSocket) => void)[] = [];
  const wss = new WebSocketServer({
    server: bastion,
    path: "/v1/tunnel",
    handleProtocols: (protocols) =>
      protocols.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false,
  });
  wss.on("connection", (socket, request) => {
    if (request.headers.authorization !== "Bearer tunnel-token") {
      socket.close(1008, "unauthorized");
      return;
    }
    const waiter = waiters.shift();
    if (waiter === undefined) sockets.push(socket);
    else waiter(socket);
  });
  const bastionPort = await listen(bastion);

  const result: Harness = {
    bastionUrl: `http://127.0.0.1:${bastionPort}`,
    loopbackBaseUrl: `http://127.0.0.1:${appPort}`,
    next: () =>
      new Promise<WebSocket>((resolve) => {
        const ready = sockets.shift();
        if (ready !== undefined) resolve(ready);
        else waiters.push(resolve);
      }),
    stop: async () => {
      wss.close();
      await new Promise<void>((resolve) => bastion.close(() => resolve()));
      await new Promise<void>((resolve) => app.close(() => resolve()));
    },
  };
  started.push(result);
  return result;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.stop();
});

function collect(socket: WebSocket, onFrame: (frame: ReturnType<typeof decodeFrame>) => void): void {
  socket.on("message", (data) => {
    onFrame(decodeFrame(new Uint8Array(data as Buffer)));
  });
}

describe("runTunnel", () => {
  it("fetches a response from the bb server through a stream", async () => {
    const body = "x".repeat(WINDOW_THRESHOLD * 2);
    const test = await harness(body);
    const controller = new AbortController();
    const tunnel = runTunnel({
      bastionUrl: test.bastionUrl,
      token: "tunnel-token",
      loopbackBaseUrl: test.loopbackBaseUrl,
      signal: controller.signal,
    });
    const socket = await test.next();

    const received: Buffer[] = [];
    let windowCredit = 0;
    const done = new Promise<void>((resolve) => {
      collect(socket, (frame) => {
        if (frame.op === OP_DATA) {
          received.push(Buffer.from(frame.payload));
          const text = Buffer.concat(received).toString("utf8");
          if (text.includes("\r\n\r\n") && text.endsWith(body)) resolve();
        }
        if (frame.op === OP_WINDOW) windowCredit += windowIncrement(frame);
      });
    });

    socket.send(encodeFrame(1, OP_OPEN), { binary: true });
    socket.send(
      encodeFrame(
        1,
        OP_DATA,
        new TextEncoder().encode(
          "GET /hello HTTP/1.1\r\nHost: bb\r\nConnection: close\r\n\r\n",
        ),
      ),
      { binary: true },
    );

    await done;
    const text = Buffer.concat(received).toString("utf8");
    expect(text).toContain("HTTP/1.1 200 OK");
    expect(text).toContain("x-path: /hello");
    expect(text.endsWith(body)).toBe(true);
    expect(windowCredit).toBeGreaterThan(0);

    controller.abort();
    await tunnel;
  });

  it("answers a ping with the same payload", async () => {
    const test = await harness("ok");
    const controller = new AbortController();
    const tunnel = runTunnel({
      bastionUrl: test.bastionUrl,
      token: "tunnel-token",
      loopbackBaseUrl: test.loopbackBaseUrl,
      signal: controller.signal,
    });
    const socket = await test.next();
    const pong = new Promise<Uint8Array>((resolve) => {
      collect(socket, (frame) => {
        if (frame.op === OP_PONG) resolve(frame.payload);
      });
    });
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    socket.send(encodeFrame(0, OP_PING, payload), { binary: true });
    expect(toHex(await pong)).toBe(toHex(payload));
    controller.abort();
    await tunnel;
  });

  it("closes the tunnel on a protocol error", async () => {
    const test = await harness("ok");
    const controller = new AbortController();
    const tunnel = runTunnel({
      bastionUrl: test.bastionUrl,
      token: "tunnel-token",
      loopbackBaseUrl: test.loopbackBaseUrl,
      signal: controller.signal,
      minBackoffMs: 50,
    });
    const socket = await test.next();
    const closed = new Promise<number>((resolve) => {
      socket.on("close", (code) => resolve(code));
    });
    socket.send(encodeFrame(7, 0x09), { binary: true });
    expect(await closed).toBe(1002);
    controller.abort();
    await tunnel;
  });

  it("reconnects after the tunnel drops", async () => {
    const test = await harness("ok");
    const controller = new AbortController();
    const tunnel = runTunnel({
      bastionUrl: test.bastionUrl,
      token: "tunnel-token",
      loopbackBaseUrl: test.loopbackBaseUrl,
      signal: controller.signal,
      minBackoffMs: 10,
    });
    const first = await test.next();
    first.close(4000, "replaced");
    const second = await test.next();
    expect(second).not.toBe(first);
    controller.abort();
    await tunnel;
  });

  it("gives up a tunnel that goes silent and reconnects", async () => {
    const test = await harness("ok");
    const controller = new AbortController();
    const warnings: string[] = [];
    const tunnel = runTunnel({
      bastionUrl: test.bastionUrl,
      token: "tunnel-token",
      loopbackBaseUrl: test.loopbackBaseUrl,
      signal: controller.signal,
      minBackoffMs: 10,
      silenceTimeoutMs: 100,
      log: { info: () => {}, warn: (message) => warnings.push(message) },
    });
    const first = await test.next();
    const closed = new Promise<number>((resolve) => {
      first.on("close", (code) => resolve(code));
    });
    // The bastion never pings: the client must not wait on TCP to notice.
    const second = await test.next();
    expect(second).not.toBe(first);
    expect(await closed).toBe(1006);
    expect(warnings.some((w) => w.includes("silent for 100ms"))).toBe(true);
    controller.abort();
    await tunnel;
  });

  it("keeps a tunnel the bastion pings", async () => {
    const test = await harness("ok");
    const controller = new AbortController();
    let connections = 0;
    const tunnel = runTunnel({
      bastionUrl: test.bastionUrl,
      token: "tunnel-token",
      loopbackBaseUrl: test.loopbackBaseUrl,
      signal: controller.signal,
      minBackoffMs: 10,
      silenceTimeoutMs: 120,
      onConnected: (connected) => {
        if (connected) connections += 1;
      },
    });
    const socket = await test.next();
    const nonce = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const pinger = setInterval(() => {
      socket.send(encodeFrame(0, OP_PING, nonce), { binary: true });
    }, 40);
    await new Promise((resolve) => setTimeout(resolve, 400));
    clearInterval(pinger);
    expect(connections).toBe(1);
    expect(socket.readyState).toBe(socket.OPEN);
    controller.abort();
    await tunnel;
  });

  it("stops without waiting on a peer that will not answer the close", async () => {
    // A socket whose peer is gone: close() starts a handshake nobody
    // completes, and only terminate() ever produces a close event.
    class DeadSocket extends EventEmitter {
      readyState = 1;
      readonly OPEN = 1;
      closeCalls = 0;
      constructor() {
        super();
        queueMicrotask(() => this.emit("open"));
      }
      send(): void {}
      close(): void {
        this.closeCalls += 1;
      }
      terminate(): void {
        this.readyState = 3;
        this.emit("close", 1006, Buffer.alloc(0));
      }
    }
    const dead = new DeadSocket();
    const controller = new AbortController();
    const started = Date.now();
    const tunnel = runTunnel({
      bastionUrl: "http://bastion.invalid",
      token: "tunnel-token",
      loopbackBaseUrl: "http://127.0.0.1:1",
      signal: controller.signal,
      closeGraceMs: 50,
      createSocket: () => dead as unknown as WebSocket,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await tunnel;
    expect(dead.closeCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("closes a stream the bb server refuses", async () => {
    const test = await harness("ok");
    const controller = new AbortController();
    const tunnel = runTunnel({
      bastionUrl: test.bastionUrl,
      token: "tunnel-token",
      loopbackBaseUrl: "http://127.0.0.1:1",
      signal: controller.signal,
    });
    const socket = await test.next();
    const close = new Promise<string>((resolve) => {
      collect(socket, (frame) => {
        if (frame.op === OP_CLOSE) {
          resolve(Buffer.from(frame.payload).toString("utf8"));
        }
      });
    });
    socket.send(encodeFrame(1, OP_OPEN), { binary: true });
    expect(await close).toContain("dial:");
    controller.abort();
    await tunnel;
  });
});
