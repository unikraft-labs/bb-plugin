import { describe, expect, it } from "vitest";
import { serviceLinks } from "./sandbox-services";

const FQDN = "misty-star-l0rymjk4.sfo.unikraft.app";

describe("serviceLinks", () => {
  it("addresses every published port on the hostname", () => {
    expect(serviceLinks(FQDN, [{ port: 3000 }, { port: 8080 }])).toEqual([
      {
        port: 3000,
        label: `${FQDN}:3000`,
        href: `https://${FQDN}:3000`,
      },
      {
        port: 8080,
        label: `${FQDN}:8080`,
        href: `https://${FQDN}:8080`,
      },
    ]);
  });

  it("has nothing to show without a hostname", () => {
    expect(serviceLinks(null, [{ port: 3000 }])).toEqual([]);
    expect(serviceLinks("", [{ port: 3000 }])).toEqual([]);
  });

  it("has nothing to show without a published port", () => {
    expect(serviceLinks(FQDN, [])).toEqual([]);
  });
});
