import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db from "@/db";
import { invoiceLines, invoices } from "@/db/schema";
import {
  makeSchool,
  makeStream,
  makeStudent,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * Fees: structures, the invoice run, and the ledger.
 *
 * The generator is the piece that gets pressed once a term against every
 * family at the school, so most of what follows is about it being safe to
 * press: idempotent, honest about who it could not bill, and copying figures
 * rather than pointing at them.
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

async function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

/** A school with Grade 4 Blue, three children in it, and a bursar. */
async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const bursar = await signInAt(school.id, "bursar");

  const kids = [];
  for (const [n, given] of [
    ["2026/001", "Wanjiku"],
    ["2026/002", "Otieno"],
    ["2026/003", "Chebet"],
  ] as const) {
    kids.push(await makeStudent(school, n, {
      givenName: given,
      streamId: blue.id,
      boardingStatus: "day",
    }));
  }

  const grade4 = school.gradeLevels.find(g => g.sequence === 4)!;
  const term1 = school.terms[0];

  async function setFees(items: Array<{ name: string; amountCents: number; isOptional?: boolean }>) {
    const res = await post("/fee-structures", {
      termId: term1.id,
      gradeLevelId: grade4.id,
      boardingStatus: "day",
      items,
    }, jsonHeaders(subdomain, bursar));
    return res.json();
  }

  return { school, blue, bursar, kids, grade4, term1, setFees };
}

const TUITION = { name: "Tuition", amountCents: 1_800_000 };

describe("fees", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("fee structures", () => {
    it("records fees for a grade and boarding status", async () => {
      const { setFees } = await seed("alpha");

      const structure = await setFees([
        TUITION,
        { name: "Lunch", amountCents: 400_000, isOptional: true },
      ]);

      expect(structure.items).toHaveLength(2);
      // Optional items are excluded: this is what a bulk run would bill.
      expect(structure.mandatoryTotalCents).toBe(1_800_000);
    });

    it("422s an amount that is not a whole shilling", async () => {
      const { bursar, grade4, term1 } = await seed("alpha");

      // M-Pesa moves whole shillings. The DB has a CHECK; this turns what
      // would be a 500 into something a bursar can act on.
      const res = await post("/fee-structures", {
        termId: term1.id,
        gradeLevelId: grade4.id,
        boardingStatus: "day",
        items: [{ name: "Tuition", amountCents: 1_800_050 }],
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(422);
    });

    it("409s a second structure for the same grade, term and boarding status", async () => {
      const { bursar, grade4, term1 } = await seed("alpha");

      const body = {
        termId: term1.id,
        gradeLevelId: grade4.id,
        boardingStatus: "day",
        items: [TUITION],
      };

      expect((await post("/fee-structures", body, jsonHeaders("alpha", bursar))).status).toBe(201);
      expect((await post("/fee-structures", body, jsonHeaders("alpha", bursar))).status).toBe(409);
    });

    it("422s a term belonging to another school", async () => {
      const { bursar, grade4 } = await seed("alpha");
      const beta = await makeSchool({ subdomain: "beta" });

      const res = await post("/fee-structures", {
        termId: beta.terms[0].id,
        gradeLevelId: grade4.id,
        boardingStatus: "day",
        items: [TUITION],
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(422);
    });

    it("403s a teacher, who has no business seeing fees", async () => {
      const { school } = await seed("alpha");
      const teacher = await signInAt(school.id, "teacher");

      const res = await app.request("/fee-structures", {
        headers: tenantHeaders("alpha", teacher),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("generating a term's invoices", () => {
    it("bills every enrolled child with a matching structure", async () => {
      const { bursar, term1, setFees } = await seed("alpha");
      await setFees([TUITION, { name: "Activity", amountCents: 200_000 }]);

      const res = await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
        dueOn: "2026-02-06",
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.created).toBe(3);
      expect(body.totalBilledCents).toBe(3 * 2_000_000);
      expect(body.unbillable).toEqual([]);
    });

    it("copies the figures onto the invoice rather than pointing at them", async () => {
      const { bursar, kids, term1, setFees } = await seed("alpha");
      const structure = await setFees([TUITION]);

      await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar));

      // The school raises tuition mid-year.
      const itemId = structure.items[0].id;
      await app.request(`/fee-items/${itemId}`, {
        method: "PATCH",
        headers: jsonHeaders("alpha", bursar),
        body: JSON.stringify({ amountCents: 2_500_000 }),
      });

      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.studentId, kids[0].id));
      const lines = await db
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoice.id));

      // A parent holding a printed sheet and a bursar reading the screen have
      // to see the same number. Joining back to fee_items would silently
      // rewrite what the family was told they owed.
      expect(invoice.totalCents).toBe(1_800_000);
      expect(lines[0].amountCents).toBe(1_800_000);
    });

    it("is safe to run twice", async () => {
      const { bursar, term1, setFees } = await seed("alpha");
      await setFees([TUITION]);

      const body = {
        termId: term1.id,
        issuedOn: "2026-01-06",
      };

      const first = await (await post("/invoices/generate", body, jsonHeaders("alpha", bursar))).json();
      const second = await (await post("/invoices/generate", body, jsonHeaders("alpha", bursar))).json();

      // A bursar unsure whether the run completed will press it again.
      expect(first.created).toBe(3);
      expect(second.created).toBe(0);
      expect(second.skippedExisting).toBe(3);
      expect(await db.select().from(invoices)).toHaveLength(3);
    });

    it("excludes optional items from the bulk run", async () => {
      const { bursar, term1, setFees } = await seed("alpha");
      await setFees([
        TUITION,
        { name: "Transport", amountCents: 600_000, isOptional: true },
      ]);

      const body = await (await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar))).json();

      // Invoicing every child for a bus they do not ride costs more trust than
      // it collects.
      expect(body.totalBilledCents).toBe(3 * 1_800_000);
    });

    it("reports children it cannot bill instead of dropping them", async () => {
      const { school, bursar, term1, setFees } = await seed("alpha");
      await setFees([TUITION]);

      // Admitted but not yet placed in a class.
      await makeStudent(school, "2026/099", { givenName: "Unplaced" });

      // Placed in a grade with no fee structure.
      const g5 = await makeStream(school, 5, "East");
      await makeStudent(school, "2026/100", {
        givenName: "Nostructure",
        streamId: g5.id,
        boardingStatus: "day",
      });

      const body = await (await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar))).json();

      expect(body.created).toBe(3);
      expect(body.unbillable).toHaveLength(2);

      const reasons = Object.fromEntries(
        body.unbillable.map((u: { admissionNumber: string; reason: string }) =>
          [u.admissionNumber, u.reason]),
      );
      // The first anyone would otherwise hear of this is a parent who was
      // never billed at all.
      expect(reasons["2026/099"]).toBe("no_open_enrollment");
      expect(reasons["2026/100"]).toBe("no_fee_structure");
    });

    it("bills a boarder at the boarder rate", async () => {
      const { school, bursar, grade4, term1, setFees } = await seed("alpha");
      await setFees([TUITION]);

      await post("/fee-structures", {
        termId: term1.id,
        gradeLevelId: grade4.id,
        boardingStatus: "boarder",
        items: [{ name: "Tuition and board", amountCents: 4_500_000 }],
      }, jsonHeaders("alpha", bursar));

      const blue = await makeStream(school, 4, "Boarding");
      const boarder = await makeStudent(school, "2026/200", {
        givenName: "Kiplagat",
        streamId: blue.id,
        boardingStatus: "boarder",
      });

      await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar));

      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.studentId, boarder.id));

      expect(invoice.totalCents).toBe(4_500_000);
    });

    it("does not bill an exited student", async () => {
      const { school, bursar, kids, term1, setFees } = await seed("alpha");
      await setFees([TUITION]);

      await post(`/students/${kids[0].id}/exit`, {
        status: "withdrawn",
        exitedOn: "2026-01-10",
      }, jsonHeaders("alpha", await signInAt(school.id, "admin")));

      const body = await (await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar))).json();

      // A withdrawn child who still gets invoiced is the failure the whole
      // enrollment shape exists to prevent.
      expect(body.created).toBe(2);
      expect(body.unbillable).toEqual([]);
    });

    it("writes nothing on a dry run", async () => {
      const { bursar, term1, setFees } = await seed("alpha");
      await setFees([TUITION]);

      const body = await (await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
        dryRun: true,
      }, jsonHeaders("alpha", bursar))).json();

      // An invoice run touches every family at the school. Seeing what it
      // would do is what makes it safe to press.
      expect(body.created).toBe(3);
      expect(body.totalBilledCents).toBe(3 * 1_800_000);
      expect(await db.select().from(invoices)).toHaveLength(0);
    });

    it("bills none of another school's children", async () => {
      const alphaSeed = await seed("alpha");
      await alphaSeed.setFees([TUITION]);
      const betaSeed = await seed("beta");
      await betaSeed.setFees([TUITION]);

      await post("/invoices/generate", {
        termId: alphaSeed.term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", alphaSeed.bursar));

      const rows = await db.select().from(invoices);
      expect(rows).toHaveLength(3);
      expect(rows.every(r => r.schoolId === alphaSeed.school.id)).toBe(true);
    });
  });

  describe("adjusting an invoice", () => {
    async function billed(subdomain: string) {
      const s = await seed(subdomain);
      await s.setFees([TUITION]);
      await post("/invoices/generate", {
        termId: s.term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders(subdomain, s.bursar));

      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.studentId, s.kids[0].id));

      return { ...s, invoice };
    }

    it("applies a bursary as a negative line and recomputes the total", async () => {
      const { bursar, invoice } = await billed("alpha");

      const res = await post(`/invoices/${invoice.id}/lines`, {
        description: "Bursary — hardship",
        amountCents: -800_000,
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(201);
      const body = await res.json();

      expect(body.totalCents).toBe(1_000_000);
      // The stored total and the lines must never be seen disagreeing.
      const sum = body.lines.reduce(
        (n: number, l: { amountCents: number }) => n + l.amountCents,
        0,
      );
      expect(sum).toBe(body.totalCents);
    });

    it("voids rather than deletes", async () => {
      const { bursar, invoice } = await billed("alpha");

      const res = await post(`/invoices/${invoice.id}/void`, {
        reason: "Duplicate of the January run",
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.voidedAt).not.toBeNull();
      expect(body.voidReason).toMatch(/duplicate/i);
      // A cancelled bill still has to be explicable months later.
      expect(await db.select().from(invoices)).toHaveLength(3);
    });

    it("409s adding a line to a voided invoice", async () => {
      const { bursar, invoice } = await billed("alpha");
      await post(`/invoices/${invoice.id}/void`, { reason: "wrong" }, jsonHeaders("alpha", bursar));

      const res = await post(`/invoices/${invoice.id}/lines`, {
        description: "Late fee",
        amountCents: 100_000,
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(409);
    });

    it("409s a second void", async () => {
      const { bursar, invoice } = await billed("alpha");
      const body = { reason: "wrong" };
      await post(`/invoices/${invoice.id}/void`, body, jsonHeaders("alpha", bursar));
      const again = await post(`/invoices/${invoice.id}/void`, body, jsonHeaders("alpha", bursar));

      expect(again.status).toBe(409);
    });
  });

  describe("payments and balances", () => {
    async function billed(subdomain: string) {
      const s = await seed(subdomain);
      await s.setFees([TUITION]);
      await post("/invoices/generate", {
        termId: s.term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders(subdomain, s.bursar));

      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.studentId, s.kids[0].id));

      return { ...s, invoice };
    }

    it("records a cash receipt and moves the balance", async () => {
      const { bursar, kids, invoice } = await billed("alpha");

      const res = await post("/payments", {
        studentId: kids[0].id,
        invoiceId: invoice.id,
        method: "cash",
        amountCents: 500_000,
        reference: "RCPT-0001",
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(201);

      const balances = await (await app.request("/balances", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      const row = balances.balances.find(
        (b: { studentId: string }) => b.studentId === kids[0].id,
      );
      expect(row).toMatchObject({
        billedCents: 1_800_000,
        paidCents: 500_000,
        balanceCents: 1_300_000,
      });
    });

    it("refuses an M-Pesa payment entered by hand", async () => {
      const { bursar, kids } = await billed("alpha");

      // Those arrive through reconciliation, so the raw Daraja row stays the
      // source of truth and a mis-allocation is always reversible.
      const res = await post("/payments", {
        studentId: kids[0].id,
        method: "mpesa",
        amountCents: 500_000,
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(422);
    });

    it("422s a payment that is not a whole shilling", async () => {
      const { bursar, kids } = await billed("alpha");

      const res = await post("/payments", {
        studentId: kids[0].id,
        method: "cash",
        amountCents: 500_050,
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(422);
    });

    it("422s a zero payment", async () => {
      const { bursar, kids } = await billed("alpha");

      const res = await post("/payments", {
        studentId: kids[0].id,
        method: "cash",
        amountCents: 0,
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(422);
    });

    it("reverses a payment and restores the debt", async () => {
      const { bursar, kids, invoice } = await billed("alpha");

      const payment = await (await post("/payments", {
        studentId: kids[0].id,
        invoiceId: invoice.id,
        method: "cheque",
        amountCents: 1_800_000,
      }, jsonHeaders("alpha", bursar))).json();

      const res = await post(`/payments/${payment.id}/reverse`, {
        reason: "Cheque bounced",
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(200);

      const balances = await (await app.request("/balances", {
        headers: tenantHeaders("alpha", bursar),
      })).json();
      const row = balances.balances.find(
        (b: { studentId: string }) => b.studentId === kids[0].id,
      );

      expect(row.paidCents).toBe(0);
      expect(row.balanceCents).toBe(1_800_000);
    });

    it("does not net families in credit against families who owe", async () => {
      const { bursar, kids, invoice } = await billed("alpha");

      // One family overpays substantially.
      await post("/payments", {
        studentId: kids[0].id,
        invoiceId: invoice.id,
        method: "bank",
        amountCents: 5_000_000,
      }, jsonHeaders("alpha", bursar));

      const balances = await (await app.request("/balances", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      // Two children still owe 1,800,000 each. The credit must not reduce the
      // figure a head reads as "outstanding", or the number is smaller than
      // the money actually missing.
      expect(balances.totalOutstandingCents).toBe(2 * 1_800_000);
    });

    it("filters to families who owe", async () => {
      const { bursar, kids, invoice } = await billed("alpha");

      await post("/payments", {
        studentId: kids[0].id,
        invoiceId: invoice.id,
        method: "cash",
        amountCents: 1_800_000,
      }, jsonHeaders("alpha", bursar));

      const owing = await (await app.request("/balances?owingOnly=true", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      expect(owing.balances).toHaveLength(2);
      expect(owing.balances.every((b: { balanceCents: number }) => b.balanceCents > 0)).toBe(true);
    });

    it("422s a payment against another school's student", async () => {
      const { bursar } = await billed("alpha");
      const betaSeed = await seed("beta");

      const res = await post("/payments", {
        studentId: betaSeed.kids[0].id,
        method: "cash",
        amountCents: 500_000,
      }, jsonHeaders("alpha", bursar));

      expect(res.status).toBe(422);
    });
  });
});
