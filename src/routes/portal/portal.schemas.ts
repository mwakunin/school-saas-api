import { z } from "@hono/zod-openapi";

import { toZodV4SchemaTyped } from "@/lib/zod-utils";

/**
 * What a guardian sees, and nothing else.
 *
 * RLS keeps one school out of another's data. It does NOT keep one family out
 * of another's — every guardian at a school passes the same tenant policy. So
 * the scoping here is a second axis entirely, done in the query and tested on
 * its own: a guardian resolves to their linked `guardians` rows, those resolve
 * to a set of student ids, and every read is confined to that set.
 */
export const claimResultSchema = toZodV4SchemaTyped(
  z.object({
    /** Guardian records now linked to this account at this school. */
    linked: z.number().int(),
    /** Already linked before this call — claiming twice is not an error. */
    alreadyLinked: z.number().int(),
    children: z.number().int(),
    /**
     * Why nothing matched, when nothing did.
     *
     * A parent who signed up with a different number from the one the school
     * holds is the ordinary case, and "0 linked" with no explanation sends
     * them to the office with nothing useful to say.
     */
    matchedOn: z.array(z.enum(["phone", "email"])),
    /**
     * More than one unclaimed guardian record matched, so none was taken.
     *
     * Two records sharing a contact are as likely to be two people as one, and
     * linking both would hand one family the other's children. The office
     * settles it — that is what `POST /guardians/{id}/link` is for.
     */
    ambiguous: z.boolean(),
  }),
);

const child = z.object({
  studentId: z.uuid(),
  admissionNumber: z.string(),
  name: z.string(),
  className: z.string().nullable(),
  relationship: z.string().nullable(),
  /** The whole account, across every term (rule 4). Negative means in credit. */
  balanceCents: z.number().int(),
});

export const myChildrenSchema = toZodV4SchemaTyped(z.array(child));

export const childResultsSchema = toZodV4SchemaTyped(
  z.object({
    termId: z.uuid(),
    termNumber: z.number().int(),
    year: z.number().int(),
    learningAreas: z.array(z.object({
      name: z.string(),
      meanScore: z.number().nullable(),
      overallLevel: z.string().nullable(),
      /** Absent where the school does not publish positions (§5.6). */
      streamPosition: z.number().int().nullable(),
      outOf: z.number().int().nullable(),
    })),
  }),
);

export const childReportCardSchema = toZodV4SchemaTyped(
  z.object({
    id: z.uuid(),
    termId: z.uuid(),
    releasedAt: z.string(),
    /** The frozen document, exactly as it was printed. */
    snapshot: z.record(z.string(), z.unknown()),
    classTeacherComment: z.string().nullable(),
    headComment: z.string().nullable(),
    verificationUrl: z.string().nullable(),
  }),
);

export const childFeesSchema = toZodV4SchemaTyped(
  z.object({
    balanceCents: z.number().int(),
    billedCents: z.number().int(),
    paidCents: z.number().int(),
    /** The M-Pesa account reference, so a parent can pay from this screen. */
    payToAccount: z.string(),
    invoices: z.array(z.object({
      id: z.uuid(),
      termId: z.uuid(),
      totalCents: z.number().int(),
      issuedOn: z.string(),
      dueOn: z.string().nullable(),
      voidedAt: z.string().nullable(),
    })),
    payments: z.array(z.object({
      id: z.uuid(),
      amountCents: z.number().int(),
      method: z.string(),
      receivedAt: z.string(),
      reference: z.string().nullable(),
      reversedAt: z.string().nullable(),
    })),
  }),
);
