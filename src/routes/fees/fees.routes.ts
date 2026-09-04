import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import {
  forbiddenSchema,
  notFoundSchema,
  unauthorizedSchema,
} from "@/lib/constants";
import { requireMembershipRole } from "@/middlewares/auth";

import {
  addInvoiceLineSchema,
  createFeeItemSchema,
  createFeeStructureSchema,
  feeStructureSchema,
  generateInvoicesResultSchema,
  generateInvoicesSchema,
  invoiceSchema,
  listFeeStructuresQuerySchema,
  listInvoicesQuerySchema,
  listPaymentsQuerySchema,
  paymentSchema,
  recordPaymentSchema,
  reversePaymentSchema,
  studentBalanceSchema,
  updateFeeItemSchema,
  voidInvoiceSchema,
} from "./fees.schemas";

const tags = ["Fees"];

/**
 * Money is the bursar's job, and the admin's.
 *
 * Teachers are absent from every route here — a class teacher has no business
 * seeing which families are behind on fees, and a school that let them would
 * find that out the hard way. Guardians reach their own children's invoices
 * through the parent portal, which is a separate surface.
 */
const money = requireMembershipRole("admin", "bursar");
/** Voiding an invoice and reversing a payment are corrections of record. */
const seniorMoney = requireMembershipRole("admin", "bursar");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    notFoundSchema,
    "No school at this address, or no such record in it",
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role, or school suspended"),
};

// --- Fee structures ---

export const listStructures = createRoute({
  tags,
  method: "get",
  path: "/fee-structures",
  summary: "Fee structures",
  middleware: [money],
  request: { query: listFeeStructuresQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.array(feeStructureSchema),
      "Structures with their items",
    ),
    ...errorResponses,
  },
});

export const createStructure = createRoute({
  tags,
  method: "post",
  path: "/fee-structures",
  summary: "Set fees for a grade and boarding status",
  middleware: [money],
  request: {
    body: jsonContentRequired(createFeeStructureSchema, "The structure and its items"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(feeStructureSchema, "The new structure"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "That term, grade and boarding status already has a structure",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createFeeStructureSchema),
      "Validation error, or the term or grade belongs to another school",
    ),
    ...errorResponses,
  },
});

export const addItem = createRoute({
  tags,
  method: "post",
  path: "/fee-structures/{id}/items",
  summary: "Add a fee item",
  middleware: [money],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(createFeeItemSchema, "The item"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(feeStructureSchema, "The structure"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createFeeItemSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const updateItem = createRoute({
  tags,
  method: "patch",
  path: "/fee-items/{id}",
  summary: "Correct a fee item",
  description:
    "Changes the template only. Invoices already generated keep the figures "
    + "they were printed with — a school raising tuition mid-year must not "
    + "silently rewrite what families were told they owed.",
  middleware: [money],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(updateFeeItemSchema, "The changes"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(feeStructureSchema, "The structure"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(updateFeeItemSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const removeItem = createRoute({
  tags,
  method: "delete",
  path: "/fee-items/{id}",
  summary: "Remove a fee item",
  description:
    "Deletes from the template. Nothing already invoiced is affected, because "
    + "invoice lines are copies rather than references.",
  middleware: [money],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(feeStructureSchema, "The structure"),
    ...errorResponses,
  },
});

// --- Invoices ---

export const generate = createRoute({
  tags,
  method: "post",
  path: "/invoices/generate",
  summary: "Generate a term's invoices",
  description:
    "Bills every actively enrolled student whose grade and boarding status "
    + "has a fee structure, copying the mandatory items onto each invoice. "
    + "Optional items are not included — they are added per family. Safe to "
    + "re-run: students already invoiced for the term are skipped.",
  middleware: [money],
  request: { body: jsonContentRequired(generateInvoicesSchema, "The run") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      generateInvoicesResultSchema,
      "What was billed, and who could not be",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(generateInvoicesSchema),
      "Validation error, or the term belongs to another school",
    ),
    ...errorResponses,
  },
});

export const listInvoices = createRoute({
  tags,
  method: "get",
  path: "/invoices",
  summary: "Invoices",
  middleware: [money],
  request: { query: listInvoicesQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ invoices: z.array(invoiceSchema), total: z.number().int() }),
      "Invoices with what is outstanding on each",
    ),
    ...errorResponses,
  },
});

export const getInvoice = createRoute({
  tags,
  method: "get",
  path: "/invoices/{id}",
  summary: "One invoice",
  middleware: [money],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(invoiceSchema, "The invoice and its lines"),
    ...errorResponses,
  },
});

export const addLine = createRoute({
  tags,
  method: "post",
  path: "/invoices/{id}/lines",
  summary: "Add a line, a bursary or a discount",
  description:
    "A negative amount is a bursary or correction. The invoice total is "
    + "recomputed from its lines in the same transaction, so the two can never "
    + "disagree.",
  middleware: [money],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(addInvoiceLineSchema, "The line"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(invoiceSchema, "The invoice"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "The invoice is voided"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(addInvoiceLineSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const voidInvoice = createRoute({
  tags,
  method: "post",
  path: "/invoices/{id}/void",
  summary: "Void an invoice",
  description:
    "Never deleted. A cancelled bill still has to be explicable months later, "
    + "and the payments made against it still have to point somewhere.",
  middleware: [seniorMoney],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(voidInvoiceSchema, "Why"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(invoiceSchema, "The voided invoice"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Already voided"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(voidInvoiceSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

// --- Payments ---

export const recordPayment = createRoute({
  tags,
  method: "post",
  path: "/payments",
  summary: "Record a cash, bank or cheque payment",
  description:
    "M-Pesa payments are not recorded here — they arrive through "
    + "reconciliation, so that the raw Daraja confirmation stays the source of "
    + "truth and a mis-allocation is always reversible.",
  middleware: [money],
  request: { body: jsonContentRequired(recordPaymentSchema, "The receipt") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(paymentSchema, "The payment"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(recordPaymentSchema),
      "Validation error, or the student or invoice belongs to another school",
    ),
    ...errorResponses,
  },
});

export const listPayments = createRoute({
  tags,
  method: "get",
  path: "/payments",
  summary: "Payments",
  middleware: [money],
  request: { query: listPaymentsQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ payments: z.array(paymentSchema), total: z.number().int() }),
      "Payments",
    ),
    ...errorResponses,
  },
});

export const reversePayment = createRoute({
  tags,
  method: "post",
  path: "/payments/{id}/reverse",
  summary: "Reverse a payment",
  description:
    "For a receipt entered against the wrong child, or a bounced cheque. The "
    + "row stays, so the money is still traceable.",
  middleware: [seniorMoney],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(reversePaymentSchema, "Why"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(paymentSchema, "The reversed payment"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Already reversed"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(reversePaymentSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

// --- Balances ---

export const listBalances = createRoute({
  tags,
  method: "get",
  path: "/balances",
  summary: "Outstanding balances",
  description:
    "Derived, never stored: billed minus paid, excluding voided invoices and "
    + "reversed payments. A negative balance means the family is in credit.",
  middleware: [money],
  request: {
    query: z.object({
      streamId: z.uuid().optional(),
      gradeLevelId: z.uuid().optional(),
      /** Hide families who are square or in credit. */
      owingOnly: z.stringbool().default(false),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        balances: z.array(studentBalanceSchema),
        totalOutstandingCents: z.number().int(),
      }),
      "Balances per student",
    ),
    ...errorResponses,
  },
});

export type ListStructuresRoute = typeof listStructures;
export type CreateStructureRoute = typeof createStructure;
export type AddItemRoute = typeof addItem;
export type UpdateItemRoute = typeof updateItem;
export type RemoveItemRoute = typeof removeItem;
export type GenerateRoute = typeof generate;
export type ListInvoicesRoute = typeof listInvoices;
export type GetInvoiceRoute = typeof getInvoice;
export type AddLineRoute = typeof addLine;
export type VoidInvoiceRoute = typeof voidInvoice;
export type RecordPaymentRoute = typeof recordPayment;
export type ListPaymentsRoute = typeof listPayments;
export type ReversePaymentRoute = typeof reversePayment;
export type ListBalancesRoute = typeof listBalances;
