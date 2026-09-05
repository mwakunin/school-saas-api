import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import { smsMessages } from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

export const smsMessageSchema = toZodV4SchemaTyped(createSelectSchema(smsMessages));

/**
 * Who a broadcast reaches.
 *
 * Grade and stream, because that is how a school thinks about "the parents of
 * Grade 7" — and because a whole-school send is four hundred messages and real
 * money, so narrowing has to be the easy thing to do.
 */
const audience = {
  termId: z.uuid(),
  gradeLevelId: z.uuid().optional(),
  streamId: z.uuid().optional(),
};

/**
 * `dryRun` defaults to TRUE, which is the unusual choice and the deliberate one.
 *
 * Every other write in this codebase does the thing you asked for. This one
 * spends a school's money and cannot be taken back: an SMS delivered to four
 * hundred families is not something an undo button can retrieve. So the safe
 * call is the default, and sending is the one you have to ask for — a bursar
 * who mistypes a filter sees the recipient count and the cost instead of a
 * bill.
 */
export const resultsNoticeSchema = toZodV4SchemaTyped(
  z.object({
    ...audience,
    /**
     * Wording the school chooses per send — an opener reads differently from
     * an end-of-term. `{name}` and `{school}` are substituted; anything else
     * is left alone rather than silently blanked.
     */
    message: z.string().min(10).max(400).optional(),
    /** Only families whose report card has actually been released. */
    releasedOnly: z.boolean().default(true),
    dryRun: z.boolean().default(true),
  }),
);

export const feeReminderSchema = toZodV4SchemaTyped(
  z.object({
    ...audience,
    message: z.string().min(10).max(400).optional(),
    /** Skip trivial arrears; chasing KES 50 costs more than it collects. */
    minBalanceCents: z.number().int().min(0).default(100_00),
    dryRun: z.boolean().default(true),
  }),
);

export const broadcastResultSchema = toZodV4SchemaTyped(
  z.object({
    dryRun: z.boolean(),
    /** Null on a dry run — nothing was queued, so there is no batch. */
    batchId: z.uuid().nullable(),
    recipients: z.number().int(),
    /** Estimated before sending, from the provider's figures after. */
    estimatedSegments: z.number().int(),
    estimatedCostCents: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    /** A handful, so a bursar can eyeball the wording before spending. */
    sample: z.array(z.object({ to: z.string(), body: z.string() })),
    /** Families skipped, and why — a guardian with no phone is invisible otherwise. */
    skipped: z.array(z.object({
      admissionNumber: z.string(),
      reason: z.enum(["no_guardian", "no_report_card", "no_balance"]),
    })),
  }),
);

export const listSmsQuerySchema = z.object({
  batchId: z.uuid().optional(),
  status: z.enum(["queued", "sent", "delivered", "failed", "rejected"]).optional(),
  kind: z.enum(["results", "fees", "announcement"]).optional(),
  studentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const smsListSchema = toZodV4SchemaTyped(
  z.object({
    messages: z.array(createSelectSchema(smsMessages)),
    total: z.number().int(),
    /** What this selection has cost so far — the question a school asks. */
    totalCostCents: z.number().int(),
  }),
);

/** Africa's Talking delivery report. Field names are theirs, not ours. */
export const deliveryReportSchema = z.object({
  id: z.string(),
  status: z.string(),
  phoneNumber: z.string().optional(),
  failureReason: z.string().optional(),
  networkCode: z.string().optional(),
});
