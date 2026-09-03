import { describe, expect, it } from "vitest";

import { subdomainFrom } from "./subdomain";

/**
 * The value this returns picks which school's data a request may touch, so the
 * cases that matter most are the ones where it must refuse.
 */
describe("subdomainFrom", () => {
  const root = "example.co.ke";

  it.each([
    ["stmarys.example.co.ke", "stmarys"],
    ["hill-academy.example.co.ke", "hill-academy"],
    ["school2026.example.co.ke", "school2026"],
    // Ports are routine locally and behind some proxies.
    ["stmarys.example.co.ke:9999", "stmarys"],
    // Host headers are not case-normalised by the client.
    ["StMarys.Example.Co.Ke", "stmarys"],
    ["  stmarys.example.co.ke  ", "stmarys"],
  ])("resolves %s", (host, expected) => {
    expect(subdomainFrom(host, root)).toBe(expected);
  });

  it.each([
    ["undefined host", undefined],
    ["empty host", ""],
    // The apex belongs to the marketing site, not a school.
    ["the apex domain", "example.co.ke"],
    ["a different domain", "stmarys.example.com"],
    ["a domain that merely ends similarly", "notexample.co.ke"],
    // The dangerous one: anyone able to create a DNS record under a school's
    // name would otherwise inherit that school's session cookies.
    ["a nested subdomain", "evil.stmarys.example.co.ke"],
    ["a leading-hyphen label", "-bad.example.co.ke"],
    ["a trailing-hyphen label", "bad-.example.co.ke"],
    ["an underscore", "not_valid.example.co.ke"],
    ["an empty label", ".example.co.ke"],
  ])("refuses %s", (_case, host) => {
    expect(subdomainFrom(host, root)).toBeNull();
  });

  it.each(["www", "api", "admin", "app", "static", "assets"])(
    "refuses the reserved name %s",
    (reserved) => {
      expect(subdomainFrom(`${reserved}.${root}`, root)).toBeNull();
    },
  );

  it("does not reserve `demo`, which is a real tenant", () => {
    // CLAUDE.md §8: the demo is a real school seeded through the real API, so
    // that it cannot drift from the product it is demonstrating.
    expect(subdomainFrom(`demo.${root}`, root)).toBe("demo");
  });

  it("works against a single-label root, as local development uses", () => {
    expect(subdomainFrom("stmarys.localhost:9999", "localhost")).toBe("stmarys");
    expect(subdomainFrom("localhost:9999", "localhost")).toBeNull();
  });

  it("refuses an IPv6 literal", () => {
    expect(subdomainFrom("[::1]:9999", "localhost")).toBeNull();
  });
});
