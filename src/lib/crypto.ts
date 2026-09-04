import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import env from "@/env";

/**
 * Encryption for the per-school Daraja credentials.
 *
 * Each school collects fees on its own paybill (CLAUDE.md §5.8) — money never
 * routes through our account — so we hold one set of Safaricom API credentials
 * per tenant. A leak of that column is a leak of every school's ability to
 * transact, so it is encrypted at rest rather than merely access-controlled:
 * a database backup, a replica, or a `SELECT *` in a support session must not
 * be enough.
 *
 * AES-256-GCM, which authenticates as well as encrypts. That matters more than
 * confidentiality here: the ciphertext lives in a column an attacker with
 * write access could tamper with, and GCM makes a modified value fail to
 * decrypt rather than decrypt to something else.
 */

const ALGORITHM = "aes-256-gcm";
/** 96 bits, the size GCM is specified for and fastest with. */
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/**
 * Format version, carried in the ciphertext.
 *
 * Every stored value says how it was encrypted, so the algorithm or key
 * derivation can change without a migration that has to guess at the old
 * format. Rotating to `v2` becomes: decrypt whichever version a row carries,
 * write back the current one.
 */
const VERSION = "v1";

export class CryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoError";
  }
}

let cachedKey: Buffer | null = null;

/**
 * The master key, decoded once.
 *
 * Read lazily rather than at import time so that a deployment without
 * encryption configured still boots — the API has plenty of routes that never
 * touch a credential, and taking the whole service down because one of them
 * would fail is the wrong trade. The failure surfaces at the first encrypt or
 * decrypt instead, which is where it can say something useful.
 */
function masterKey(): Buffer {
  if (cachedKey)
    return cachedKey;

  const configured = env.CREDENTIALS_ENCRYPTION_KEY;

  if (!configured) {
    throw new CryptoError(
      "CREDENTIALS_ENCRYPTION_KEY is not set, so per-school M-Pesa credentials "
      + "cannot be stored or read. Generate one with: "
      + `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  const key = Buffer.from(configured, "base64");

  if (key.length !== KEY_BYTES) {
    throw new CryptoError(
      `CREDENTIALS_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. `
      + "It should be base64 of 32 random bytes.",
    );
  }

  cachedKey = key;
  return key;
}

/** Test seam: forces the key to be re-read after the environment changes. */
export function resetKeyCache() {
  cachedKey = null;
}

/**
 * Encrypts a secret for storage.
 *
 * Returns `v1.<iv>.<tag>.<ciphertext>`, each part base64url. A fresh random IV
 * per call is what keeps two schools that happen to share a passkey from
 * producing identical ciphertext — which would otherwise be visible to anyone
 * reading the column, without decrypting anything.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypts a stored secret.
 *
 * Throws on anything that is not exactly what `encryptSecret` produced with
 * the current key — a truncated value, a tampered tag, a different key. There
 * is deliberately no fallback to returning the input: a caller that treated a
 * failed decrypt as "the credential is this string" would send garbage to
 * Safaricom and log it.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(".");

  if (parts.length !== 4) {
    throw new CryptoError(
      "Malformed encrypted value: expected version.iv.tag.ciphertext",
    );
  }

  const [version, ivPart, tagPart, dataPart] = parts;

  if (version !== VERSION)
    throw new CryptoError(`Unsupported encryption version '${version}'`);

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new CryptoError("Malformed encrypted value: bad IV or tag length");

  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey(), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
  catch (err) {
    // The underlying message ("Unsupported state or unable to authenticate
    // data") says nothing a caller can act on, and repeating it invites
    // treating a tampered value as a transient fault.
    throw new CryptoError(
      "Could not decrypt: the value was tampered with, truncated, or "
      + "encrypted under a different key",
      { cause: err },
    );
  }
}

/** Whether a stored string looks like something `decryptSecret` could read. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split(".").length === 4;
}

/**
 * Constant-time comparison, for the per-school webhook token.
 *
 * The token is the only thing standing between a stranger and the ability to
 * file fabricated payments against a school, so it is compared without an
 * early return on the first differing byte. Length is compared first and
 * separately — that much is unavoidably observable, and it leaks nothing,
 * since the token length is fixed and public.
 */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length)
    return false;

  return timingSafeEqual(left, right);
}

/** A URL-safe token with 256 bits of entropy, for a school's callback path. */
export function generateCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}
