export const SANDBOX_POLL_MS = 5_000;
export const SANDBOX_POLL_MAX_MS = 60_000;

export type PollOutcome = "found" | "missing" | "failed";

export function nextInterval(current: number, outcome: PollOutcome): number {
  if (outcome === "found") return SANDBOX_POLL_MS;
  if (outcome === "missing") return SANDBOX_POLL_MAX_MS;
  return Math.min(current * 2, SANDBOX_POLL_MAX_MS);
}
