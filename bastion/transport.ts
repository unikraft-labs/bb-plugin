import type {
  CallOptions,
  QueryValue,
  RequestArgs,
  Transport,
} from "./api/transport";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface TransportOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

export class BastionRequestError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "BastionRequestError";
    this.status = status;
    this.body = body;
  }
}

function appendQuery(path: string, query: RequestArgs["query"]): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  const add = (key: string, value: QueryValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, String(entry));
      return;
    }
    params.append(key, String(value));
  };
  for (const [key, value] of Object.entries(query)) add(key, value);
  const search = params.toString();
  return search === "" ? path : `${path}?${search}`;
}

export function createTransport(options: TransportOptions): Transport {
  const call = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(
    args: RequestArgs,
    callOptions: CallOptions | undefined,
    accept: string,
  ): Promise<Response> {
    const base = (callOptions?.baseUrl ?? options.baseUrl).replace(/\/+$/u, "");
    const url = `${base}${appendQuery(args.path, args.query)}`;
    const headers: Record<string, string> = {
      accept,
      authorization: `Bearer ${options.token}`,
      ...(callOptions?.headers ?? {}),
    };
    const init: RequestInit = { method: args.method, headers };
    if (args.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(args.body);
    }
    if (callOptions?.signal !== undefined) init.signal = callOptions.signal;
    const response = await call(url, init);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const detail = envelopeMessage(body);
      throw new BastionRequestError(
        response.status,
        body,
        `${args.method} ${args.path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return response;
  }

  return {
    async request<T>(args: RequestArgs, callOptions?: CallOptions): Promise<T> {
      const response = await send(args, callOptions, "application/json");
      const text = await response.text();
      if (text.trim() === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BastionRequestError(
          response.status,
          text,
          `${args.method} ${args.path} returned a body that is not JSON`,
        );
      }
    },

    async bytes(
      args: RequestArgs,
      callOptions?: CallOptions,
    ): Promise<Uint8Array> {
      const response = await send(args, callOptions, "application/octet-stream");
      return new Uint8Array(await response.arrayBuffer());
    },

    async *stream<T>(
      args: RequestArgs,
      callOptions?: CallOptions,
    ): AsyncGenerator<T, void, void> {
      const response = await send(args, callOptions, "text/event-stream");
      const body = response.body;
      if (body === null) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/u, "");
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "") continue;
          yield JSON.parse(payload) as T;
        }
      }
    },
  };
}

function envelopeMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string" &&
      parsed.message !== ""
    ) {
      return parsed.message;
    }
  } catch {}
  return undefined;
}
