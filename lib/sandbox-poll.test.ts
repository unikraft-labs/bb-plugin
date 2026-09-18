import { describe, expect, it } from "vitest";
import {
  nextInterval,
  SANDBOX_POLL_MAX_MS,
  SANDBOX_POLL_MS,
} from "./sandbox-poll";

describe("nextInterval", () => {
  it("keeps a live sandbox on the short interval", () => {
    expect(nextInterval(SANDBOX_POLL_MS, "found")).toBe(SANDBOX_POLL_MS);
    expect(nextInterval(SANDBOX_POLL_MAX_MS, "found")).toBe(SANDBOX_POLL_MS);
  });

  it("drops a thread without a sandbox to the long interval", () => {
    expect(nextInterval(SANDBOX_POLL_MS, "missing")).toBe(SANDBOX_POLL_MAX_MS);
  });

  it("doubles the interval on failure up to the cap", () => {
    const schedule: number[] = [];
    let interval = SANDBOX_POLL_MS;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      interval = nextInterval(interval, "failed");
      schedule.push(interval);
    }
    expect(schedule).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });
});
