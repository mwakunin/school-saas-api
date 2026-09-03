import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppDb } from "@/db";
import type { TenantRouteHandler } from "@/lib/types";

import {
  enrollments,
  feeItems,
  feeStructures,
  invoiceLines,
  invoices,
  payments,
  streams,
  students,
  terms,
} from "@/db/schema";
import {
  balancesFor,
  invoiceBalancesFor,
  recomputeInvoiceTotal,
} from "@/lib/balances";
import { isForeignKeyViolation, isUniqueViolation } from "@/lib/db-errors";

import type {
  AddItemRoute,
  AddLineRoute,
  CreateStructureRoute,
  GenerateRoute,
  GetInvoiceRoute,
  ListBalancesRoute,
  ListInvoicesRoute,
  ListPaymentsRoute,
  ListStructuresRoute,
  RecordPaymentRoute,
  RemoveItemRoute,
  ReversePaymentRoute,
  UpdateItemRoute,
  VoidInvoiceRoute,
} from "./fees.routes";

/** Field-level 422, shaped like the one `defaultHook` produces for Zod. */
function fieldError(path: string[], message: string) {
  return {
    success: false as const,
    error: {
      issues: [{ code: "custom" as const, path, message }],
      name: "ZodError",
    },
  };
}

async function structureDetail(db: AppDb, structureId: string) {
  const [structure] = await db
    .select()
    .from(feeStructures)
    .where(eq(feeStructures.id, structureId));

  if (!structure)
    return null;

  const items = await db
    .select()
    .from(feeItems)
    .where(eq(feeItems.feeStructureId, structureId))
    .orderBy(asc(feeItems.name));

  return {
    ...structure,
    items,
    // What a bulk run would actually bill: optional items are excluded, so
    // this is the figure to compare against last term's.
    mandatoryTotalCents: items
      .filter(i => !i.isOptional)
      .reduce((sum, i) => sum + i.amountCents, 0),
  };
}

async function invoiceDetail(db: AppDb, invoiceId: string) {
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId));

  if (!invoice)
    return null;

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId));

  const balances = await invoiceBalancesFor(db, [invoiceId]);
  const balance = balances.get(invoiceId)!;

  return {
    ...invoice,
    lines,
    paidCents: balance.paidCents,
    outstandingCents: balance.outstandingCents,
  };
}

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

export const listStructures: TenantRouteHandler<ListStructuresRoute> = async (c) => {
  const { termId } = c.req.valid("query");
  const db = c.var.db;

  const rows = await db
    .select({ id: feeStructures.id })
    .from(feeStructures)
    .where(termId ? eq(feeStructures.termId, termId) : undefined);

  const detailed = await Promise.all(rows.map(r => structureDetail(db, r.id)));

  return c.json(detailed.filter(s => s !== null), HttpStatusCodes.OK);
};

export const createStructure: TenantRouteHandler<CreateStructureRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;
  const schoolId = c.var.school.id;

  try {
    const id = await db.transaction(async (tx) => {
      const [structure] = await tx
        .insert(feeStructures)
        .values({
          schoolId,
          termId: body.termId,
          gradeLevelId: body.gradeLevelId,
          boardingStatus: body.boardingStatus,
        })
        .returning();

      await tx.insert(feeItems).values(body.items.map(item => ({
        schoolId,
        feeStructureId: structure.id,
        name: item.name,
        amountCents: item.amountCents,
        isOptional: item.isOptional,
      })));

      return structure.id;
    });

    return c.json((await structureDetail(db, id))!, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That term, grade and boarding status already has a structure" },
        HttpStatusCodes.CONFLICT,
      );
    }
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["termId"], "No such term or grade level at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};

export const addItem: TenantRouteHandler<AddItemRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  try {
    await db.insert(feeItems).values({
      schoolId: c.var.school.id,
      feeStructureId: id,
      name: body.name,
      amountCents: body.amountCents,
      isOptional: body.isOptional,
    });
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );
    }
    throw err;
  }

  return c.json((await structureDetail(db, id))!, HttpStatusCodes.CREATED);
};

export const updateItem: TenantRouteHandler<UpdateItemRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  const [updated] = await db
    .update(feeItems)
    .set(body)
    .where(eq(feeItems.id, id))
    .returning({ feeStructureId: feeItems.feeStructureId });

  if (!updated) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // Deliberately does not touch invoices already generated: their lines are
  // copies, so a mid-year rise leaves last term's bills as printed.
  return c.json((await structureDetail(db, updated.feeStructureId))!, HttpStatusCodes.OK);
};

export const removeItem: TenantRouteHandler<RemoveItemRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  const [removed] = await db
    .delete(feeItems)
    .where(eq(feeItems.id, id))
    .returning({ feeStructureId: feeItems.feeStructureId });

  if (!removed) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json((await structureDetail(db, removed.feeStructureId))!, HttpStatusCodes.OK);
};

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const generate: TenantRouteHandler<GenerateRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;
  const schoolId = c.var.school.id;

  // Invisible under RLS if it belongs to another school, so this doubles as
  // the tenant check.
  const [term] = await db
    .select({ id: terms.id })
    .from(terms)
    .where(eq(terms.id, body.termId));

  if (!term) {
    return c.json(
      fieldError(["termId"], "No such term at this school"),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  /*
   * Who gets billed: actively enrolled students, by their OPEN enrollment.
   *
   * The open enrollment supplies both halves of the fee key — the grade level
   * (through the stream) and the boarding status. Reading either from anywhere
   * else would bill a child who moved up in September at last year's rate.
   */
  const roll = await db
    .select({
      studentId: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
      gradeLevelId: streams.gradeLevelId,
      boardingStatus: enrollments.boardingStatus,
    })
    .from(students)
    .leftJoin(enrollments, and(
      eq(enrollments.studentId, students.id),
      isNull(enrollments.endedOn),
    ))
    .leftJoin(streams, eq(enrollments.streamId, streams.id))
    .where(eq(students.status, "active"))
    .orderBy(asc(students.familyName), asc(students.givenName));

  // The structures for this term, keyed by what identifies one.
  const structures = await db
    .select({
      id: feeStructures.id,
      gradeLevelId: feeStructures.gradeLevelId,
      boardingStatus: feeStructures.boardingStatus,
    })
    .from(feeStructures)
    .where(eq(feeStructures.termId, body.termId));

  const structureIds = structures.map(s => s.id);

  // Only mandatory items are billed in bulk. Transport and lunch are real
  // charges but only for the families that take them, and invoicing every
  // child for a bus they do not ride costs more trust than it collects.
  const items = structureIds.length > 0
    ? await db
        .select()
        .from(feeItems)
        .where(and(
          inArray(feeItems.feeStructureId, structureIds),
          eq(feeItems.isOptional, false),
        ))
    : [];

  const itemsByStructure = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByStructure.get(item.feeStructureId) ?? [];
    list.push(item);
    itemsByStructure.set(item.feeStructureId, list);
  }

  const structureFor = new Map(
    structures.map(s => [`${s.gradeLevelId}:${s.boardingStatus}`, s.id]),
  );

  // Already invoiced for this term. Re-running a generation must be harmless:
  // a bursar who is unsure whether it completed will press it again.
  const existing = await db
    .select({ studentId: invoices.studentId })
    .from(invoices)
    .where(eq(invoices.termId, body.termId));

  const alreadyInvoiced = new Set(existing.map(r => r.studentId));

  const unbillable: Array<{
    studentId: string;
    admissionNumber: string;
    name: string;
    reason: "no_open_enrollment" | "no_fee_structure";
  }> = [];

  const toBill: Array<{
    studentId: string;
    lines: Array<{ description: string; amountCents: number }>;
    totalCents: number;
  }> = [];

  let skippedExisting = 0;

  for (const row of roll) {
    if (alreadyInvoiced.has(row.studentId)) {
      skippedExisting += 1;
      continue;
    }

    const name = `${row.givenName} ${row.familyName}`;

    // A student with no open enrollment is in no class, so there is no fee to
    // apply. Reported rather than skipped silently: the first anyone would
    // otherwise hear of it is a parent who was never billed.
    if (!row.gradeLevelId || !row.boardingStatus) {
      unbillable.push({
        studentId: row.studentId,
        admissionNumber: row.admissionNumber,
        name,
        reason: "no_open_enrollment",
      });
      continue;
    }

    const structureId = structureFor.get(
      `${row.gradeLevelId}:${row.boardingStatus}`,
    );

    if (!structureId) {
      unbillable.push({
        studentId: row.studentId,
        admissionNumber: row.admissionNumber,
        name,
        reason: "no_fee_structure",
      });
      continue;
    }

    const structureItems = itemsByStructure.get(structureId) ?? [];
    const lines = structureItems.map(i => ({
      // COPIED, not referenced (CLAUDE.md §5.7). When the school raises
      // tuition mid-year, this invoice must keep saying what it said.
      description: i.name,
      amountCents: i.amountCents,
    }));

    toBill.push({
      studentId: row.studentId,
      lines,
      totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
    });
  }

  const totalBilledCents = toBill.reduce((sum, i) => sum + i.totalCents, 0);

  if (body.dryRun) {
    return c.json({
      created: toBill.length,
      skippedExisting,
      totalBilledCents,
      unbillable,
    }, HttpStatusCodes.OK);
  }

  if (toBill.length > 0) {
    await db.transaction(async (tx) => {
      const created = await tx
        .insert(invoices)
        .values(toBill.map(i => ({
          schoolId,
          studentId: i.studentId,
          termId: body.termId,
          totalCents: i.totalCents,
          issuedOn: body.issuedOn,
          dueOn: body.dueOn,
        })))
        .returning({ id: invoices.id, studentId: invoices.studentId });

      const invoiceIdByStudent = new Map(created.map(r => [r.studentId, r.id]));

      const allLines = toBill.flatMap(i =>
        i.lines.map(l => ({
          schoolId,
          invoiceId: invoiceIdByStudent.get(i.studentId)!,
          description: l.description,
          amountCents: l.amountCents,
        })),
      );

      if (allLines.length > 0)
        await tx.insert(invoiceLines).values(allLines);
    });
  }

  return c.json({
    created: toBill.length,
    skippedExisting,
    totalBilledCents,
    unbillable,
  }, HttpStatusCodes.OK);
};

export const listInvoices: TenantRouteHandler<ListInvoicesRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.termId)
    filters.push(eq(invoices.termId, query.termId));
  if (query.studentId)
    filters.push(eq(invoices.studentId, query.studentId));
  if (!query.includeVoided)
    filters.push(isNull(invoices.voidedAt));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [{ total }] = await db
    .select({ total: count() })
    .from(invoices)
    .where(where);

  const rows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(where)
    .orderBy(desc(invoices.issuedOn))
    .limit(query.limit)
    .offset(query.offset);

  const detailed = await Promise.all(rows.map(r => invoiceDetail(db, r.id)));
  const list = detailed.filter(i => i !== null);

  // Filtered after the fact: "outstanding" is derived from payments, so it is
  // not a column the query could have used. Fine at a term's scale, and the
  // alternative is a stored balance that drifts (CLAUDE.md §3 rule 4).
  const filtered = query.outstandingOnly
    ? list.filter(i => i.outstandingCents > 0)
    : list;

  return c.json({ invoices: filtered, total }, HttpStatusCodes.OK);
};

export const getInvoice: TenantRouteHandler<GetInvoiceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const invoice = await invoiceDetail(c.var.db, id);

  if (!invoice) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(invoice, HttpStatusCodes.OK);
};

export const addLine: TenantRouteHandler<AddLineRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  const [invoice] = await db
    .select({ voidedAt: invoices.voidedAt })
    .from(invoices)
    .where(eq(invoices.id, id));

  if (!invoice) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (invoice.voidedAt) {
    return c.json(
      { message: "This invoice is voided" },
      HttpStatusCodes.CONFLICT,
    );
  }

  await db.transaction(async (tx) => {
    await tx.insert(invoiceLines).values({
      schoolId: c.var.school.id,
      invoiceId: id,
      description: body.description,
      amountCents: body.amountCents,
    });

    // In the same transaction, so the stored total and the lines can never be
    // seen disagreeing.
    await recomputeInvoiceTotal(tx, id);
  });

  return c.json((await invoiceDetail(db, id))!, HttpStatusCodes.CREATED);
};

export const voidInvoice: TenantRouteHandler<VoidInvoiceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  const db = c.var.db;

  const [invoice] = await db
    .select({ voidedAt: invoices.voidedAt })
    .from(invoices)
    .where(eq(invoices.id, id));

  if (!invoice) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (invoice.voidedAt) {
    return c.json(
      { message: "This invoice is already voided" },
      HttpStatusCodes.CONFLICT,
    );
  }

  await db
    .update(invoices)
    // The CHECK ties these together, so they move as a pair.
    .set({ voidedAt: new Date(), voidReason: reason })
    .where(eq(invoices.id, id));

  return c.json((await invoiceDetail(db, id))!, HttpStatusCodes.OK);
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const recordPayment: TenantRouteHandler<RecordPaymentRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  try {
    const [created] = await db
      .insert(payments)
      .values({
        schoolId: c.var.school.id,
        studentId: body.studentId,
        invoiceId: body.invoiceId,
        method: body.method,
        amountCents: body.amountCents,
        reference: body.reference,
        recordedBy: c.var.user!.id,
        receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
      })
      .returning();

    return c.json(created, HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["studentId"], "No such student or invoice at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};

export const listPayments: TenantRouteHandler<ListPaymentsRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.studentId)
    filters.push(eq(payments.studentId, query.studentId));
  if (query.invoiceId)
    filters.push(eq(payments.invoiceId, query.invoiceId));
  if (!query.includeReversed)
    filters.push(isNull(payments.reversedAt));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [{ total }] = await db
    .select({ total: count() })
    .from(payments)
    .where(where);

  const rows = await db
    .select()
    .from(payments)
    .where(where)
    .orderBy(desc(payments.receivedAt))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({ payments: rows, total }, HttpStatusCodes.OK);
};

export const reversePayment: TenantRouteHandler<ReversePaymentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");
  const db = c.var.db;

  const [payment] = await db
    .select({ reversedAt: payments.reversedAt })
    .from(payments)
    .where(eq(payments.id, id));

  if (!payment) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (payment.reversedAt) {
    return c.json(
      { message: "This payment is already reversed" },
      HttpStatusCodes.CONFLICT,
    );
  }

  // Reversed, not deleted: "where did this KES 15,000 go" has to stay
  // answerable, and the row is the only thing that can answer it.
  const [updated] = await db
    .update(payments)
    .set({ reversedAt: new Date(), reversalReason: reason })
    .where(eq(payments.id, id))
    .returning();

  return c.json(updated, HttpStatusCodes.OK);
};

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export const listBalances: TenantRouteHandler<ListBalancesRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [eq(students.status, "active")];

  if (query.streamId || query.gradeLevelId) {
    const enrollmentFilters = [isNull(enrollments.endedOn)];
    if (query.streamId)
      enrollmentFilters.push(eq(enrollments.streamId, query.streamId));
    if (query.gradeLevelId)
      enrollmentFilters.push(eq(streams.gradeLevelId, query.gradeLevelId));

    const matching = db
      .select({ id: enrollments.studentId })
      .from(enrollments)
      .innerJoin(streams, eq(enrollments.streamId, streams.id))
      .where(and(...enrollmentFilters));

    filters.push(inArray(students.id, matching));
  }

  const roll = await db
    .select({
      id: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
    })
    .from(students)
    .where(and(...filters))
    .orderBy(asc(students.familyName), asc(students.givenName))
    .limit(query.limit)
    .offset(query.offset);

  const balances = await balancesFor(db, roll.map(s => s.id));

  const rows = roll.map((s) => {
    const balance = balances.get(s.id);
    return {
      studentId: s.id,
      admissionNumber: s.admissionNumber,
      name: `${s.givenName} ${s.familyName}`,
      billedCents: balance?.billedCents ?? 0,
      paidCents: balance?.paidCents ?? 0,
      balanceCents: balance?.balanceCents ?? 0,
    };
  });

  const shown = query.owingOnly ? rows.filter(r => r.balanceCents > 0) : rows;

  return c.json({
    balances: shown,
    // Only debts count towards the school's outstanding figure — families in
    // credit must not net off against families who owe, or the number a head
    // reads is smaller than the money actually missing.
    totalOutstandingCents: rows
      .filter(r => r.balanceCents > 0)
      .reduce((sum, r) => sum + r.balanceCents, 0),
  }, HttpStatusCodes.OK);
};
