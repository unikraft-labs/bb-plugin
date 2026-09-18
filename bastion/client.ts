import { BbBastionPluginApi } from "./api/index";
import type { models } from "./api/api/index.gen";
import { createTransport, type FetchLike } from "./transport";

export interface BastionEndpoint {
  bastionUrl: string;
  bastionToken: string;
}

export interface Envelope<T> {
  status: models.ResponseStatus;
  message?: string;
  data?: T;
  errors?: models.ResponseError[];
  op_time_us: number;
}

export class BastionError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "BastionError";
    this.status = status;
  }
}

export function controlApiUrl(bastionUrl: string): string {
  return `${bastionUrl.replace(/\/+$/u, "")}/v1`;
}

export function createBastionClient(
  endpoint: BastionEndpoint,
  fetchImpl?: FetchLike,
): BbBastionPluginApi {
  return new BbBastionPluginApi(
    createTransport({
      baseUrl: controlApiUrl(endpoint.bastionUrl),
      token: endpoint.bastionToken,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    }),
  );
}

export function unwrap<T>(envelope: Envelope<T>): T {
  const status = envelope.errors?.[0]?.status ?? null;
  if (envelope.status !== "success") {
    throw new BastionError(
      envelope.message ?? "The bastion rejected the request.",
      status,
    );
  }
  if (envelope.data === undefined || envelope.data === null) {
    throw new BastionError(
      envelope.message ?? "The bastion returned no data.",
      status,
    );
  }
  return envelope.data;
}
