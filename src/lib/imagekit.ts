import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";

import env from "@/env";

/**
 * ImageKit, used for property photos.
 *
 * Files are uploaded **by the client, straight to ImageKit** — this API only
 * signs the request and records the result. Proxying the bytes would mean
 * holding multi-megabyte uploads in the request path of an API whose other
 * endpoints are small and transactional, for no benefit: ImageKit is the one
 * storing the file either way.
 *
 * That means the upload signature is a credential. It is admin-only, expires
 * quickly, and is single-use by token — see `uploadAuth`.
 */

const UPLOAD_AUTH_TTL_SECONDS = 5 * 60;
const API_BASE = "https://api.imagekit.io/v1";

/** All three are required together, so one check covers the feature. */
export const imagekitEnabled = Boolean(
  env.IMAGEKIT_PUBLIC_KEY && env.IMAGEKIT_PRIVATE_KEY && env.IMAGEKIT_URL_ENDPOINT,
);

export class ImageKitError extends Error {
  constructor(message: string, readonly status?: number, readonly cause?: unknown) {
    super(message);
    this.name = "ImageKitError";
  }
}

function privateKey(): string {
  if (!env.IMAGEKIT_PRIVATE_KEY)
    throw new ImageKitError("ImageKit is not configured (IMAGEKIT_PRIVATE_KEY)");

  return env.IMAGEKIT_PRIVATE_KEY;
}

export interface UploadAuth {
  token: string;
  expire: number;
  signature: string;
  publicKey: string;
  urlEndpoint: string;
}

/**
 * Credentials for one client-side upload.
 *
 * The signature is `HMAC-SHA1(privateKey, token + expire)`, which is what
 * ImageKit verifies. `expire` is deliberately short: the signature authorises
 * an upload into your account, so a leaked one should stop working in minutes
 * rather than the hour ImageKit permits.
 */
export function uploadAuth(): UploadAuth {
  if (!env.IMAGEKIT_PUBLIC_KEY || !env.IMAGEKIT_URL_ENDPOINT)
    throw new ImageKitError("ImageKit is not configured");

  const token = randomUUID();
  const expire = Math.floor(Date.now() / 1000) + UPLOAD_AUTH_TTL_SECONDS;

  const signature = createHmac("sha1", privateKey())
    .update(token + expire)
    .digest("hex");

  return {
    token,
    expire,
    signature,
    publicKey: env.IMAGEKIT_PUBLIC_KEY,
    urlEndpoint: env.IMAGEKIT_URL_ENDPOINT,
  };
}

/**
 * Whether a URL actually points at this account's ImageKit endpoint.
 *
 * The client tells us where the file landed, and an unchecked value means the
 * listing can be pointed at any host on the internet — a tracking pixel, or
 * something that later serves different content. Constraining it to the
 * configured endpoint keeps a stored URL to something this account controls.
 */
export function isOwnCdnUrl(url: string): boolean {
  if (!env.IMAGEKIT_URL_ENDPOINT)
    return false;

  try {
    const endpoint = new URL(env.IMAGEKIT_URL_ENDPOINT);
    const candidate = new URL(url);

    // Host and path prefix both: an ImageKit endpoint includes the account's
    // id in its path, so the host alone does not identify it.
    //
    // The prefix has to end at a segment boundary. A bare startsWith on an
    // endpoint of `/account` also matches `/account-other/evil.jpg`, which is
    // a different account on the same host — so a foreign URL would pass the
    // ownership guard and be served as a listing photo.
    const endpointPath = endpoint.pathname.replace(/\/$/, "");

    return candidate.origin === endpoint.origin
      && (candidate.pathname === endpointPath
        || candidate.pathname.startsWith(`${endpointPath}/`));
  }
  catch {
    return false;
  }
}

function authHeader(): string {
  // ImageKit uses HTTP Basic with the private key as the username and an empty
  // password, so the colon is required.
  return `Basic ${Buffer.from(`${privateKey()}:`).toString("base64")}`;
}

export interface RemoteFile {
  fileId: string;
  url: string;
  filePath: string;
}

/**
 * Ask ImageKit what it holds under a file id.
 *
 * The client reports the id and the url separately, and nothing about the two
 * has to agree — a mismatched pair (easy enough for a gallery uploading
 * several files at once to produce) stores one file's address against another
 * file's handle. Deleting that record would then remove the unrelated file and
 * leave the displayed one orphaned on the CDN, billed and unreferenced.
 *
 * So the id is resolved here and the answer is what gets stored.
 *
 * @returns the file, or null if ImageKit has no such id.
 */
export async function getFile(fileId: string): Promise<RemoteFile | null> {
  const res = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}/details`, {
    headers: { authorization: authHeader() },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404)
    return null;

  if (!res.ok) {
    throw new ImageKitError(
      `ImageKit would not describe ${fileId}: ${res.status}`,
      res.status,
    );
  }

  const body = await res.json() as { fileId?: string; url?: string; filePath?: string };

  if (!body.url || !body.filePath) {
    throw new ImageKitError(
      `ImageKit described ${fileId} without a url`,
      res.status,
    );
  }

  return { fileId: body.fileId ?? fileId, url: body.url, filePath: body.filePath };
}

/**
 * Delete a stored file.
 *
 * A 404 counts as success: the goal is "this file is not on the CDN", and it
 * already isn't. Anything else throws, so the caller can decline to remove the
 * database row — dropping the row on a failed delete is what orphans a file
 * that nothing references and nobody will ever find again.
 */
export async function deleteFile(fileId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { authorization: authHeader() },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.ok || res.status === 404)
    return;

  throw new ImageKitError(
    `ImageKit refused to delete ${fileId}: ${res.status}`,
    res.status,
  );
}
