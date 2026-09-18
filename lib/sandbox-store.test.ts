import { beforeEach, describe, expect, it } from "vitest";
import {
  consoleUrlFor,
  forgetSandboxes,
  rememberSandbox,
  subscribeSandboxes,
} from "./sandbox-store";

beforeEach(() => {
  forgetSandboxes();
});

describe("sandbox store", () => {
  it("remembers a console link by instance name", () => {
    rememberSandbox("bbx-thr-1", "https://console.unikraft.cloud/x");
    expect(consoleUrlFor("bbx-thr-1")).toBe("https://console.unikraft.cloud/x");
    expect(consoleUrlFor("bbx-thr-2")).toBeNull();
  });

  it("tells subscribers when a link appears or changes", () => {
    let calls = 0;
    const stop = subscribeSandboxes(() => {
      calls += 1;
    });
    rememberSandbox("bbx-thr-1", null);
    rememberSandbox("bbx-thr-1", null);
    rememberSandbox("bbx-thr-1", "https://console.unikraft.cloud/x");
    stop();
    rememberSandbox("bbx-thr-1", null);
    expect(calls).toBe(2);
  });
});
