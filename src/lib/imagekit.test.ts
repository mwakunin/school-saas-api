import { describe, expect, it } from "vitest";

import { isOwnCdnUrl } from "./imagekit";

/**
 * The endpoint guard, on its own.
 *
 * Exercised directly rather than only through the attach handler: that
 * handler also compares the submitted url against the one ImageKit reports,
 * which rejects a foreign url for a different reason and would hide a hole
 * here entirely.
 *
 * IMAGEKIT_URL_ENDPOINT is https://ik.imagekit.io/school-test in .env.test.
 */
describe("isOwnCdnUrl", () => {
  it.each([
    "https://ik.imagekit.io/school-test/a.jpg",
    "https://ik.imagekit.io/school-test/nested/path/a.jpg",
    "https://ik.imagekit.io/school-test/a.jpg?tr=w-400",
    "https://ik.imagekit.io/school-test",
  ])("accepts this account's own file: %s", (url) => {
    expect(isOwnCdnUrl(url)).toBe(true);
  });

  // The prefix has to end at a segment boundary. These are separate accounts
  // on the same host, and a plain startsWith lets every one of them through.
  it.each([
    "https://ik.imagekit.io/school-test-other/a.jpg",
    "https://ik.imagekit.io/school-testing/a.jpg",
    "https://ik.imagekit.io/school-test2/a.jpg",
  ])("rejects a neighbouring account on the same host: %s", (url) => {
    expect(isOwnCdnUrl(url)).toBe(false);
  });

  it.each([
    "https://evil.test/school-test/a.jpg",
    "http://ik.imagekit.io/school-test/a.jpg",
    "https://ik.imagekit.io.evil.test/school-test/a.jpg",
    "not a url at all",
    "",
  ])("rejects anything not served from this endpoint: %s", (url) => {
    expect(isOwnCdnUrl(url)).toBe(false);
  });
});
