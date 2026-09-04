import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import {
  feeItems,
  feeStructures,
  invoiceLines,
  invoices,
  payments,
} from "@/db/schema";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

const rawFeeStructure = createSelectSchema(feeStructures);
const rawFeeItem = createSelectSchema(feeItems);
const rawInvoice = createSelectSchema(invoices);
const rawInvoiceLine = createSelectSchema(invoiceLines);
const rawPayment = createSelectSchema(payments);

/**
 * Money crosses this boundary as integer cents, in whole shillings.
 *
 * The database enforces divisibility by 100 with a CHECK, which is what stops
 * a seed script or hand-written SQL slipping a bad row past. Validating here
 * too turns what would otherwise be a 500 from a constraint violation into a
 * message a bursar can act on.
 */
function wholeShillings(field: z.ZodNumber) {
  return field.int().refine(
    n => n % 100 === 0,
    "Must be a whole number of shillings (divisible by 100)",
  );
}

const amountCents = wholeShillings(z.number()).nonnegative();
/** Negative is allowed: a bursary or discount is a negative line. */
const signedAmountCents = wholeShillings(z.number());

export const feeItemSchema = toZodV4SchemaTyped(rawFeeItem);

export const feeStructureSchema = toZodV4SchemaTyped(
  rawFeeStructure.extend({
    items: z.array(rawFeeItem),
    /** What a child on this structure is billed in a bulk run. */
    mandatoryTotalCents: z.number().int(),
  }),
);

export const createFeeStructureSchema = toZodV4SchemaTyped(
  z.object({
    termId: z.uuid(),
    gradeLevelId: z.uuid(),
    boardingStatus: z.enum(["day", "boarder"]),
    items: z.array(z.object({
      name: z.string().min(1).max(100),
      amountCents,
      isOptional: z.boolean().default(false),
    })).min(1),
  }),
);

export const createFeeItemSchema = toZodV4SchemaTyped(
  z.object({
    name: z.string().min(1).max(100),
    amountCents,
    isOptional: z.boolean().default(false),
  }),
);

export const updateFeeItemSchema = toZodV4SchemaTyped(
  z.object({
    name: z.string().min(1).max(100).optional(),
    amountCents: amountCents.optional(),
    isOptional: z.boolean().optional(),
  }).refine(v => Object.keys(v).length > 0, { message: "No updates provided" }),
);

export const listFeeStructuresQuerySchema = z.object({
  termId: z.uuid().optional(),
});

// --- Invoices ---

export const invoiceSchema = toZodV4SchemaTyped(
  rawInvoice.extend({
    lines: z.array(rawInvoiceLine),
    /** Payments allocated to this invoice; a credit on account is not one. */
    paidCents: z.number().int(),
    outstandingCents: z.number().int(),
  }),
);

export const generateInvoicesSchema = toZodV4SchemaTyped(
  z.object({
    termId: z.uuid(),
    issuedOn: z.iso.date(),
    dueOn: z.iso.date().optional(),
    /**
     * Preview without writing anything.
     *
     * An invoice run touches every family at the school. Being able to see
     * what it would do — including which children it cannot bill and why — is
     * what makes it safe to press the button.
     */
    dryRun: z.boolean().default(false),
  }),
);

export const generateInvoicesResultSchema = toZodV4SchemaTyped(
  z.object({
    created: z.number().int(),
    /** Already invoiced for this term, so left alone. Re-running is harmless. */
    skippedExisting: z.number().int(),
    totalBilledCents: z.number().int(),
    /**
     * Children the run could not bill, each with the reason.
     *
     * Surfaced rather than silently dropped: a child with no open enrollment
     * or no matching fee structure is invisible to the school otherwise, and
     * the first anyone hears of it is a parent who was never billed.
     */
    unbillable: z.array(z.object({
      studentId: z.uuid(),
      admissionNumber: z.string(),
      name: z.string(),
      reason: z.enum(["no_open_enrollment", "no_fee_structure"]),
    })),
  }),
);

export const addInvoiceLineSchema = toZodV4SchemaTyped(
  z.object({
    description: z.string().min(1).max(200),
    /** Negative for a bursary, discount or correction. */
    amountCents: signedAmountCents,
  }),
);

export const voidInvoiceSchema = toZodV4SchemaTyped(
  z.object({
    reason: z.string().min(1).max(500),
  }),
);

export const listInvoicesQuerySchema = z.object({
  termId: z.uuid().optional(),
  studentId: z.uuid().optional(),
  /** Only invoices with money still outstanding. */
  outstandingOnly: z.stringbool().default(false),
  includeVoided: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Payments ---

export const paymentSchema = toZodV4SchemaTyped(rawPayment);

export const recordPaymentSchema = toZodV4SchemaTyped(
  z.object({
    studentId: z.uuid(),
    /** Omit to leave the money as a credit on the student's account. */
    invoiceId: z.uuid().optional(),
    // M-Pesa is deliberately absent: those arrive through reconciliation in
    // step 5, never by hand, so that the raw Daraja row is always the source.
    method: z.enum(["cash", "bank", "cheque"]),
    amountCents: wholeShillings(z.number()).positive(),
    reference: z.string().max(100).optional(),
    receivedAt: z.iso.datetime().optional(),
  }),
);

export const reversePaymentSchema = toZodV4SchemaTyped(
  z.object({
    reason: z.string().min(1).max(500),
  }),
);

export const listPaymentsQuerySchema = z.object({
  studentId: z.uuid().optional(),
  invoiceId: z.uuid().optional(),
  includeReversed: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Balances ---

export const balanceSchema = toZodV4SchemaTyped(
  z.object({
    studentId: z.uuid(),
    billedCents: z.number().int(),
    paidCents: z.number().int(),
    /** Positive = owed to the school. Negative = the family is in credit. */
    balanceCents: z.number().int(),
  }),
);

export const studentBalanceSchema = toZodV4SchemaTyped(
  z.object({
    studentId: z.uuid(),
    admissionNumber: z.string(),
    name: z.string(),
    billedCents: z.number().int(),
    paidCents: z.number().int(),
    balanceCents: z.number().int(),
  }),
);

/** One class on the bursar dashboard. */
export const classBalanceSchema = toZodV4SchemaTyped(
  z.object({
    streamId: z.uuid(),
    streamName: z.string(),
    gradeLevelId: z.uuid(),
    gradeLevelName: z.string(),
    gradeLevelSequence: z.number().int(),
    studentCount: z.number().int(),
    billedCents: z.number().int(),
    paidCents: z.number().int(),
    /** Billed minus paid across the class; families in credit pull this down. */
    netCents: z.number().int(),
    /** Debts only — what the class actually owes. */
    outstandingCents: z.number().int(),
    /** Families behind on fees, which is the number a bursar chases. */
    owingCount: z.number().int(),
  }),
);
