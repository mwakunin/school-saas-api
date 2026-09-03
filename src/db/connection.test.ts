import { describe, expect, it } from "vitest";

import { isLocalDatabase, sslConfigFor } from "./connection";

/**
 * This logic was duplicated once and the copy kept an older, broken version
 * that disabled TLS on a substring match. These cases exist so a third copy,
 * or a regression in this one, fails loudly.
 */
describe("isLocalDatabase", () => {
  it.each([
    "postgresql://school:school@localhost:5436/school_dev",
    "postgresql://u:p@127.0.0.1:5432/db",
    "postgresql://u:p@[::1]:5432/db",
  ])("treats %s as local", (url) => {
    expect(isLocalDatabase(url)).toBe(true);
  });

  it.each([
    ["a remote host", "postgresql://u:p@ep-abc.neon.tech/db?sslmode=require"],
    ["a password containing localhost", "postgresql://localhost:pw@prod.neon.tech/db"],
    ["localhost in a query parameter", "postgresql://u:p@prod.neon.tech/db?opts=localhost"],
    ["a hostname merely starting with localhost", "postgresql://u:p@localhost.evil.com/db"],
    ["127.0.0.1 inside the database name", "postgresql://u:p@prod.neon.tech/db127.0.0.1"],
  ])("does NOT treat %s as local", (_label, url) => {
    expect(isLocalDatabase(url)).toBe(false);
  });

  it("fails closed on an unparseable DSN", () => {
    // Better to attempt TLS against a malformed URL than to downgrade.
    expect(isLocalDatabase("not a url at all")).toBe(false);
    expect(isLocalDatabase("")).toBe(false);
  });
});

describe("sslConfigFor", () => {
  it("disables TLS only for a genuinely local database", () => {
    expect(sslConfigFor("postgresql://u:p@localhost:5432/db")).toBe(false);
  });

  it("requires a verified certificate for anything remote", () => {
    expect(sslConfigFor("postgresql://u:p@ep-abc.neon.tech/db"))
      .toEqual({ rejectUnauthorized: true });
  });

  it("requires TLS when the password contains localhost", () => {
    // The exact downgrade the substring version allowed.
    expect(sslConfigFor("postgresql://localhost:pw@prod.neon.tech/db"))
      .toEqual({ rejectUnauthorized: true });
  });
});
