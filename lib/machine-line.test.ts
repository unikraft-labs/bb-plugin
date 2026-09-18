import { describe, expect, it } from "vitest";
import { sandboxNameFrom } from "./machine-line";

describe("sandboxNameFrom", () => {
  it("reads the instance name out of the machine line", () => {
    expect(sandboxNameFrom("Unikraft Cloud sandbox bbx-thr-abc123")).toBe(
      "bbx-thr-abc123",
    );
    expect(sandboxNameFrom("  Unikraft Cloud sandbox bbx-thr-1  ")).toBe(
      "bbx-thr-1",
    );
  });

  it("ignores every other line", () => {
    expect(sandboxNameFrom("Unikraft Cloud (bbx-thr-1)")).toBeNull();
    expect(sandboxNameFrom("Unikraft Cloud sandbox")).toBeNull();
    expect(sandboxNameFrom("Unikraft Cloud sandbox thr-1")).toBeNull();
    expect(sandboxNameFrom("my-laptop")).toBeNull();
    expect(sandboxNameFrom("")).toBeNull();
  });
});
