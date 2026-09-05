import { randomBytes } from "node:crypto";
import QRCode from "qrcode";

import env from "@/env";

/**
 * Documents that can prove they are genuine.
 *
 * A Kenyan school is handed report cards and fee receipts from elsewhere
 * constantly — at admission, at a transfer, when a parent disputes a payment —
 * and today has no way to tell a real one from a photocopy somebody edited in
 * a phone app. Both directions of that problem cost real money: a forged
 * receipt is fees never collected, and a forged report card decides a place at
 * a school.
 *
 * This is nearly free for us, which is the reason to do it now. The content is
 * ALREADY frozen — rule 7 snapshots exist so that reprinting a 2026 report card
 * in 2028 produces the same page — so the verifiable artefact is sitting there.
 * All that is missing is a code on the paper and somewhere public to check it.
 *
 * The verifier deliberately shows no more than the document itself does. It
 * confirms what is printed; it is not a back door into a school's records.
 */

/** 160 bits. Same reasoning as `mpesa_callback_token` — see below. */
const CODE_BYTES = 20;

/**
 * Mints a code for a document about to be frozen.
 *
 * Unguessable rather than sequential, because the endpoint that answers it is
 * public and unauthenticated: the code is the only thing standing between a
 * stranger and somebody else's child's marks. A sequential or short code would
 * make the whole corpus enumerable by anyone who found one.
 *
 * base64url so it survives a URL, a QR payload and being read aloud down a
 * phone line without escaping.
 */
export function mintVerificationCode(): string {
  return randomBytes(CODE_BYTES).toString("base64url");
}

/** The address printed under the QR, for someone typing it by hand. */
export function verificationUrlFor(code: string): string {
  const scheme = env.NODE_ENV === "production" ? "https" : "http";
  return `${scheme}://${env.ROOT_DOMAIN}/verify/${code}`;
}

/**
 * The QR itself, as an inline SVG.
 *
 * SVG rather than PNG because it goes into a printed document: a report card
 * is A4 and a raster QR at the wrong scale is the one that will not scan in a
 * school office with a cheap phone camera. Returned as a string so whatever
 * renders the page — a PDF pipeline, the Next app — embeds it without needing
 * this dependency itself.
 *
 * Error correction level M: tolerates the smudging and folding a document that
 * lives in a school bag actually gets, without the size cost of H.
 */
export function qrSvgFor(code: string): Promise<string> {
  return QRCode.toString(verificationUrlFor(code), {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
  });
}
