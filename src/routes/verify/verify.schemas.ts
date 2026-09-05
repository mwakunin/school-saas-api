import { z } from "@hono/zod-openapi";

import { toZodV4SchemaTyped } from "@/lib/zod-utils";

/**
 * What a verifier is told.
 *
 * Deliberately no more than the document itself shows. Somebody holding a
 * printed report card can already read the child's name, class, term and
 * marks — confirming those is the whole job. Anything beyond them would make
 * this a back door into a school's records rather than a way to check a piece
 * of paper, and the endpoint is public and unauthenticated.
 *
 * That is also why there is no lookup by name, admission number or date. The
 * only way in is a code from a document you are already holding.
 */
const common = {
  documentType: z.enum(["report_card", "payment_receipt", "transition_certificate"]),
  school: z.object({ name: z.string(), county: z.string().nullable() }),
  student: z.object({
    name: z.string(),
    admissionNumber: z.string(),
  }),
  issuedAt: z.string().nullable(),
};

export const verifiedDocumentSchema = toZodV4SchemaTyped(
  z.object({
    ...common,

    /** The term the document covers, where it covers one. */
    term: z.object({ number: z.number().int(), year: z.number().int() }).nullable(),

    /** Class at the time — a report card's own words, not today's class. */
    className: z.string().nullable(),

    /**
     * The document's own figures, straight from the frozen snapshot.
     *
     * Never recomputed. A verifier comparing this against the paper must see
     * what was printed, including if the marks behind it have since changed —
     * that is precisely what a snapshot is for (rule 7).
     */
    summary: z.record(z.string(), z.unknown()),

    /**
     * Whether the document still stands.
     *
     * A reversed payment's receipt is the case that matters: it was genuinely
     * issued and is genuinely no longer good, and a verifier being told only
     * "authentic" would be misled by a true statement. `withdrawn` is the
     * honest answer, with the reason.
     */
    status: z.enum(["valid", "withdrawn"]),
    statusReason: z.string().nullable(),
  }),
);

export const verificationNotFoundSchema = toZodV4SchemaTyped(
  z.object({
    message: z.string(),
    /*
     * The same answer for a code that never existed and one that is merely
     * mistyped. Distinguishing them would turn this into an oracle for
     * probing the code space, and it makes no difference to somebody holding
     * a document: either way, this is not one of ours.
     */
    verified: z.literal(false),
  }),
);

export const codeParamsSchema = z.object({
  code: z.string().min(16).max(64),
});
