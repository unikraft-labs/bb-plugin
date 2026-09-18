import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";

export const TUNNEL_SUBPROTOCOL = "bb-bastion-tunnel.v1";
export const TUNNEL_PATH = "/v1/tunnel";
export const INITIAL_WINDOW = 262_144;
export const MAX_DATA_PAYLOAD = 65_536;
export const WINDOW_THRESHOLD = 32_768;
export const PROTOCOL_ERROR_CODE = 1002;

export const OP_OPEN = 0x01;
export const OP_DATA = 0x02;
export const OP_CLOSE = 0x03;
export const OP_WINDOW = 0x04;
export const OP_PING = 0x05;
export const OP_PONG = 0x06;

const OPS = new Set([OP_OPEN, OP_DATA, OP_CLOSE, OP_WINDOW, OP_PING, OP_PONG]);

export interface Frame {
  streamId: number;
  op: number;
  payload: Uint8Array;
}

export class TunnelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TunnelProtocolError";
  }
}

export function encodeFrame(
  streamId: number,
  op: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, streamId >>> 0, false);
  frame[4] = op;
  frame.set(payload, 5);
  return frame;
}

export function encodeWindow(streamId: number, increment: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, increment >>> 0, false);
  return encodeFrame(streamId, OP_WINDOW, payload);
}

export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < 5) {
    throw new TunnelProtocolError("a frame is shorter than its header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamId = view.getUint32(0, false);
  const op = bytes[4] as number;
  const payload = bytes.subarray(5);
  if (!OPS.has(op)) {
    throw new TunnelProtocolError(`unknown op 0x${op.toString(16)}`);
  }
  if (op === OP_DATA && payload.length > MAX_DATA_PAYLOAD) {
    throw new TunnelProtocolError("a data frame exceeds the maximum payload");
  }
  if (op === OP_WINDOW && payload.length !== 4) {
    throw new TunnelProtocolError("a window frame carries no increment");
  }
  const tunnelOp = op === OP_PING || op === OP_PONG;
  if (streamId === 0 && !tunnelOp) {
    throw new TunnelProtocolError("the tunnel stream carries only ping and pong");
  }
  if (streamId !== 0 && tunnelOp) {
    throw new TunnelProtocolError("ping and pong belong to the tunnel stream");
  }
  return { streamId, op, payload };
}

export function windowIncrement(frame: Frame): number {
  const view = new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength,
  );
  return view.getUint32(0, false);
}

export interface TunnelTarget {
  host: string;
  port: number;
  tls: boolean;
}

export function parseTarget(baseUrl: string): TunnelTarget {
  const url = new URL(baseUrl);
  const tls = url.protocol === "https:";
  const port = url.port === "" ? (tls ? 443 : 80) : Number(url.port);
  return { host: url.hostname, port, tls };
}

export function tunnelUrl(bastionUrl: string): string {
  const base = bastionUrl.replace(/\/+$/u, "");
  const scheme = base.startsWith("http://") ? "ws://" : "wss://";
  return `${scheme}${base.replace(/^https?:\/\//u, "")}${TUNNEL_PATH}`;
}

export interface TunnelLogger {
  info(message: string): void;
  warn(message: string): void;
}

const SILENT: TunnelLogger = { info: () => {}, warn: () => {} };

export type SocketFactory = (target: TunnelTarget) => Socket;

function defaultSocketFactory(target: TunnelTarget): Socket {
  return target.tls
    ? tlsConnect({ host: target.host, port: target.port })
    : netConnect({ host: target.host, port: target.port });
}

interface StreamState {
  id: number;
  socket: Socket | null;
  outbound: Uint8Array[];
  sendWindow: number;
  owed: number;
  owedTimer: ReturnType<typeof setTimeout> | null;
  localClosed: boolean;
  paused: boolean;
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const parts = data as Uint8Array[];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }
  const view = data as Uint8Array;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export class TunnelSession {
  private readonly streams = new Map<number, StreamState>();
  private readonly closed = new Set<number>();
  private failed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly target: TunnelTarget,
    private readonly log: TunnelLogger,
    private readonly dial: SocketFactory,
  ) {
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        this.fail("the tunnel carries binary frames only");
        return;
      }
      this.receive(toBytes(data));
    });
    socket.on("close", () => this.teardown());
    socket.on("error", () => this.teardown());
  }

  private send(frame: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(frame, { binary: true });
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.log.warn(`tunnel protocol error: ${reason}`);
    this.socket.close(PROTOCOL_ERROR_CODE, reason.slice(0, 120));
    this.teardown();
  }

  private teardown(): void {
    for (const stream of this.streams.values()) {
      if (stream.owedTimer !== null) clearTimeout(stream.owedTimer);
      stream.socket?.destroy();
    }
    this.streams.clear();
  }

  private receive(bytes: Uint8Array): void {
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (frame.op === OP_PING) {
      this.send(encodeFrame(0, OP_PONG, frame.payload));
      return;
    }
    if (frame.op === OP_PONG) return;
    if (frame.op === OP_OPEN) {
      this.open(frame.streamId);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (stream === undefined) {
      if (this.closed.has(frame.streamId)) return;
      this.fail(`frame for stream ${frame.streamId}, which was never opened`);
      return;
    }
    switch (frame.op) {
      case OP_DATA:
        this.acceptData(stream, frame.payload);
        return;
      case OP_WINDOW:
        stream.sendWindow += windowIncrement(frame);
        this.flush(stream);
        return;
      case OP_CLOSE:
        this.closeStream(stream, null);
        return;
      default:
        this.fail(`unexpected op 0x${frame.op.toString(16)}`);
    }
  }

  private open(streamId: number): void {
    if (this.streams.has(streamId) || this.closed.has(streamId)) {
      this.fail(`stream ${streamId} was opened twice`);
      return;
    }
    const stream: StreamState = {
      id: streamId,
      socket: null,
      outbound: [],
      sendWindow: INITIAL_WINDOW,
      owed: 0,
      owedTimer: null,
      localClosed: false,
      paused: false,
    };
    this.streams.set(streamId, stream);
    let socket: Socket;
    try {
      socket = this.dial(this.target);
    } catch (error) {
      this.closeStream(
        stream,
        `dial: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    stream.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      stream.outbound.push(new Uint8Array(chunk));
      this.flush(stream);
    });
    socket.on("error", (error: Error) => {
      this.closeStream(stream, `dial: ${error.message}`);
    });
    socket.on("close", () => this.closeStream(stream, null));
    socket.on("end", () => this.closeStream(stream, null));
  }

  private acceptData(stream: StreamState, payload: Uint8Array): void {
    stream.socket?.write(Buffer.from(payload));
    stream.owed += payload.length;
    if (stream.owed >= WINDOW_THRESHOLD) {
      this.flushWindow(stream);
      return;
    }
    if (stream.owedTimer === null) {
      stream.owedTimer = setTimeout(() => {
        stream.owedTimer = null;
        this.flushWindow(stream);
      }, 0);
    }
  }

  private flushWindow(stream: StreamState): void {
    if (stream.owedTimer !== null) {
      clearTimeout(stream.owedTimer);
      stream.owedTimer = null;
    }
    if (stream.owed === 0) return;
    const owed = stream.owed;
    stream.owed = 0;
    this.send(encodeWindow(stream.id, owed));
  }

  private flush(stream: StreamState): void {
    while (stream.outbound.length > 0 && stream.sendWindow > 0) {
      const head = stream.outbound[0] as Uint8Array;
      const size = Math.min(head.length, MAX_DATA_PAYLOAD, stream.sendWindow);
      const chunk = head.subarray(0, size);
      if (size === head.length) {
        stream.outbound.shift();
      } else {
        stream.outbound[0] = head.subarray(size);
      }
      stream.sendWindow -= size;
      this.send(encodeFrame(stream.id, OP_DATA, chunk));
    }
    const backlog = stream.outbound.length > 0;
    if (backlog && !stream.paused) {
      stream.paused = true;
      stream.socket?.pause();
    } else if (!backlog && stream.paused) {
      stream.paused = false;
      stream.socket?.resume();
    }
  }

  private closeStream(stream: StreamState, reason: string | null): void {
    if (!this.streams.has(stream.id)) return;
    this.streams.delete(stream.id);
    this.closed.add(stream.id);
    this.flushWindow(stream);
    if (!stream.localClosed) {
      stream.localClosed = true;
      const payload =
        reason === null ? new Uint8Array(0) : new TextEncoder().encode(reason);
      this.send(encodeFrame(stream.id, OP_CLOSE, payload));
    }
    stream.socket?.destroy();
  }
}

export interface TunnelOptions {
  bastionUrl: string;
  token: string;
  loopbackBaseUrl: string;
  signal: AbortSignal;
  log?: TunnelLogger;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onConnected?: (connected: boolean) => void;
  dial?: SocketFactory;
  createSocket?: (url: string, token: string) => WebSocket;
}

function defaultWebSocket(url: string, token: string): WebSocket {
  return new WebSocket(url, [TUNNEL_SUBPROTOCOL], {
    headers: { authorization: `Bearer ${token}` },
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runTunnel(options: TunnelOptions): Promise<void> {
  const log = options.log ?? SILENT;
  const min = options.minBackoffMs ?? 1_000;
  const max = options.maxBackoffMs ?? 30_000;
  const dial = options.dial ?? defaultSocketFactory;
  const create = options.createSocket ?? defaultWebSocket;
  const target = parseTarget(options.loopbackBaseUrl);
  const url = tunnelUrl(options.bastionUrl);
  let backoff = min;

  while (!options.signal.aborted) {
    let opened = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = create(url, options.token);
        const abort = () => socket.close(1000, "stopping");
        options.signal.addEventListener("abort", abort, { once: true });
        socket.on("open", () => {
          opened = true;
          backoff = min;
          log.info("tunnel connected");
          options.onConnected?.(true);
          new TunnelSession(socket, target, log, dial);
        });
        socket.on("error", (error: Error) => {
          options.signal.removeEventListener("abort", abort);
          reject(error);
        });
        socket.on("close", () => {
          options.signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    } catch (error) {
      log.warn(
        `tunnel failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (opened) options.onConnected?.(false);
    if (options.signal.aborted) return;
    await wait(backoff, options.signal);
    backoff = Math.min(backoff * 2, max);
  }
}
