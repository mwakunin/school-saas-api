import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  CryptoError,
  decryptSecret,
  encryptSecret,
  generateCallbackToken,
  isEncrypted,
  secretEquals,
} from "./crypto";

/**
 * The credentials this protects are a school's ability to transact on its own
 * paybill. A leak of the column is a leak of every tenant's, so the tests that
 * matter are the ones about what happens when a value is not exactly what we
 * wrote.
 */
describe("credential encryption", () => {
  it("round-trips a secret", () => {
    const secret = JSON.stringify({ consumerKey: "abc", consumerSecret: "shh" });
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces different ciphertext for the same input", () => {
    // A fresh IV per call. Without it, two schools that happen to share a
    // passkey would have identical ciphertext — visible to anyone reading the
    // column, without decrypting anything.
    const a = encryptSecret("same");
    const b = encryptSecret("same");

    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("carries its format version", () => {
    // So a future algorithm change can decrypt what the old one wrote instead
    // of a migration that has to guess.
    expect(encryptSecret("x").startsWith("v1.")).toBe(true);
    expect(isEncrypted(encryptSecret("x"))).toBe(true);
    expect(isEncrypted("not-encrypted")).toBe(false);
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const encrypted = encryptSecret("consumer-secret");
    const [version, iv, tag, data] = encrypted.split(".");

    // Flip a byte in the ciphertext. GCM authenticates, so this must fail
    // rather than decrypt to something else — the column is writable by
    // anything with database access.
    const flipped = Buffer.from(data, "base64url");
    flipped[0] ^= 0xFF;

    expect(() => decryptSecret(
      [version, iv, tag, flipped.toString("base64url")].join("."),
    )).toThrow(CryptoError);
  });

  it("refuses a tampered auth tag", () => {
    const encrypted = encryptSecret("consumer-secret");
    const [version, iv, , data] = encrypted.split(".");
    const forged = Buffer.alloc(16).toString("base64url");

    expect(() => decryptSecret([version, iv, forged, data].join(".")))
      .toThrow(CryptoError);
  });

  it.each([
    ["empty", ""],
    ["not versioned", "just-a-string"],
    ["too few parts", "v1.abc.def"],
    ["unknown version", "v9.abc.def.ghi"],
    ["short IV", "v1.AAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"],
  ])("refuses a malformed value: %s", (_case, value) => {
    // Never falls back to returning the input. A caller that treated a failed
    // decrypt as "the credential is this string" would send garbage to
    // Safaricom and log it.
    expect(() => decryptSecret(value)).toThrow(CryptoError);
  });

  it("says something actionable when it fails", () => {
    expect(() => decryptSecret("v1.a.b.c")).toThrow(/Malformed|tampered|version/i);
  });
});

describe("secretEquals", () => {
  it("matches identical values and rejects everything else", () => {
    expect(secretEquals("token", "token")).toBe(true);
    expect(secretEquals("token", "tokeN")).toBe(false);
    expect(secretEquals("token", "token-longer")).toBe(false);
    expect(secretEquals("", "")).toBe(true);
  });

  it("does not throw on differing lengths", () => {
    // `timingSafeEqual` throws on mismatched buffer lengths, so the length
    // check has to come first — a callback token of the wrong length must be
    // a `false`, not a 500 on an endpoint Safaricom is calling.
    expect(() => secretEquals("a", "abcdefgh")).not.toThrow();
  });
});

describe("generateCallbackToken", () => {
  it("is long, URL-safe and unpredictable", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateCallbackToken()));

    expect(tokens.size).toBe(50);

    for (const token of tokens) {
      // 32 random bytes in base64url. This is the only thing standing between
      // a stranger and filing fabricated payments against a school.
      expect(token).toMatch(/^[\w-]{43}$/);
    }
  });
});
