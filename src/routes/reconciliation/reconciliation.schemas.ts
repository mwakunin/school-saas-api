import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { mpesaTransactions } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

const rawTransaction = createSelectSchema(mpesaTransactions);

/**
 * A queue row.
 *
 * `rawPayload` is omitted: it is Safaricom's whole envelope, kept so a field
 * we did not model stays recoverable, and it has no business on a screen a
 * bursar reads. It is available on the single-transaction view.
 */
export const transactionSchema = toZodV4SchemaTyped(
  rawTransaction.omit({ rawPayload: true }).extend({
    /**
     * Students whose admission number resembles the reference.
     *
     * Offered, never applied. Automatic matching is deliberately conservative
     * — see lib/mpesa-matching.ts — so these are the near misses a person
     * decides between, which is the difference between a suggestion and a
     * wrong allocation nobody is looking for.
     */
    suggestions: z.array(z.object({
      studentId: z.uuid(),
      admissionNumber: z.string(),
      name: z.string(),
      /** Their balance, so the obvious candidate is obvious. */
      balanceCents: z.number().int(),
    })),
  }),
);

export const transactionDetailSchema = toZodV4SchemaTyped(rawTransaction);

export const listTransactionsQuerySchema = z.object({
  status: z.enum(["unmatched", "allocated", "rejected"]).optional(),
  /** Matches the reference, the payer's name and the M-Pesa receipt. */
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const allocateSchema = toZodV4SchemaTyped(
  z.object({
    studentId: z.uuid(),
    /*
     * Deliberately no `invoiceId`.
     *
     * An earlier version accepted one and `allocateTransaction` ignored it —
     * the API would have taken a caller's decision about which term to settle
     * and silently dropped it, which is worse than not offering the choice.
     *
     * The money lands as a credit on the student's account, which is what a
     * parent paying "school fees" has actually done. Naming a term is a
     * separate act, and guessing the oldest unpaid invoice is wrong every
     * time someone pays next term in advance.
     */
  }),
);

export const rejectSchema = toZodV4SchemaTyped(
  z.object({
    reason: z.string().min(1).max(500),
  }),
);

export const runMatcherSchema = toZodV4SchemaTyped(
  z.object({
    /**
     * Where the previous pass stopped, from its `nextCursor`.
     *
     * Omit to sweep from the oldest confirmation. Supplying it is what lets a
     * backlog deeper than one batch be worked through: the rows at the front
     * of the queue are there because nothing could match them, so a sweep that
     * always restarted would re-examine the same stuck rows for ever.
     */
    after: z.string().max(200).optional(),
  }),
);

export const runMatcherResultSchema = toZodV4SchemaTyped(
  z.object({
    examined: z.number().int(),
    allocated: z.number().int(),
    stillUnmatched: z.number().int(),
    /** Confirmations a further pass would examine. Zero means the sweep is done. */
    remaining: z.number().int(),
    /** Pass back as `after` to continue. Null when there is nothing left. */
    nextCursor: z.string().nullable(),
  }),
);

/** What a school needs to give Safaricom, and what it must never reveal. */
export const mpesaSettingsSchema = toZodV4SchemaTyped(
  z.object({
    shortcode: z.string().nullable(),
    /** Whether credentials are stored. The credentials themselves never leave. */
    credentialsConfigured: z.boolean(),
    confirmationUrl: z.string().nullable(),
    validationUrl: z.string().nullable(),
  }),
);

export const configureMpesaSchema = toZodV4SchemaTyped(
  z.object({
    /** The school's own paybill or till. Money never routes through ours. */
    shortcode: z.string().min(5).max(10).regex(/^\d+$/, "Digits only"),
    consumerKey: z.string().min(1).max(200),
    consumerSecret: z.string().min(1).max(200),
    /**
     * Ask Safaricom to point this school's callbacks at us now.
     *
     * Off by default: registration is a live call to Daraja that overwrites
     * whatever URLs the school currently has registered, and doing that as a
     * side effect of saving a credential is how a working paybill gets pointed
     * somewhere else mid-term.
     */
    registerUrls: z.boolean().default(false),
  }),
);
