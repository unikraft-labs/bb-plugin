import { describe, expect, it } from "vitest";
import {
  EMPTY_SANDBOX_OPTIONS,
  parseSandboxOptions,
  submissionFor,
} from "./sandbox-options";

describe("parseSandboxOptions", () => {
  it("reads a persisted selection back into drafts", () => {
    expect(
      parseSandboxOptions({
        vcpus: 2,
        memoryMb: 8192,
        image: "ubuntu:24.04",
        ports: [8080, 3000],
      }),
    ).toEqual({
      vcpus: "2",
      memoryMb: "8192",
      image: "ubuntu:24.04",
      ports: ["8080", "3000"],
    });
  });

  it("treats anything else as empty", () => {
    expect(parseSandboxOptions(null)).toEqual(EMPTY_SANDBOX_OPTIONS);
    expect(parseSandboxOptions("8080")).toEqual(EMPTY_SANDBOX_OPTIONS);
    expect(parseSandboxOptions({ ports: ["8080"] }).ports).toEqual([]);
  });
});

describe("submissionFor", () => {
  it("submits nothing when every field is empty", () => {
    expect(submissionFor(EMPTY_SANDBOX_OPTIONS)).toEqual({
      status: "ready",
      value: null,
    });
  });

  it("submits only the fields that were filled in", () => {
    expect(
      submissionFor({
        ...EMPTY_SANDBOX_OPTIONS,
        image: " ubuntu:24.04 ",
        ports: ["8080", "", "3000"],
      }),
    ).toEqual({
      status: "ready",
      value: { image: "ubuntu:24.04", ports: [8080, 3000] },
    });
  });

  it("blocks a size outside the range", () => {
    expect(submissionFor({ ...EMPTY_SANDBOX_OPTIONS, vcpus: "32" })).toEqual({
      status: "blocked",
      reason: "vCPUs must be 1 to 16.",
    });
    expect(
      submissionFor({ ...EMPTY_SANDBOX_OPTIONS, memoryMb: "128" }),
    ).toEqual({
      status: "blocked",
      reason: "Memory must be 256 to 65536 MiB.",
    });
  });

  it("blocks a port outside the range", () => {
    expect(submissionFor({ ...EMPTY_SANDBOX_OPTIONS, ports: ["0"] })).toEqual({
      status: "blocked",
      reason: "A port must be 1 to 65535.",
    });
  });

  it("blocks the same port twice", () => {
    expect(
      submissionFor({ ...EMPTY_SANDBOX_OPTIONS, ports: ["8080", "8080"] }),
    ).toEqual({
      status: "blocked",
      reason: "Port 8080 is listed twice.",
    });
  });
});
