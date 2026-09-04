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

  describe("outstanding per class", () => {
    async function billedAcrossTwoClasses(subdomain: string) {
      const s = await seed(subdomain);
      const east = await makeStream(s.school, 5, "East");
      const grade5 = s.school.gradeLevels.find(g => g.sequence === 5)!;

      await s.setFees([TUITION]);
      await post("/fee-structures", {
        termId: s.term1.id,
        gradeLevelId: grade5.id,
        boardingStatus: "day",
        items: [{ name: "Tuition", amountCents: 2_200_000 }],
      }, jsonHeaders(subdomain, s.bursar));

      // Two more children, in Grade 5 East.
      const inEast = [];
      for (const n of ["2026/010", "2026/011"]) {
        inEast.push(await makeStudent(s.school, n, {
          givenName: `East${n.slice(-3)}`,
          streamId: east.id,
          boardingStatus: "day",
        }));
      }

      await post("/invoices/generate", {
        termId: s.term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders(subdomain, s.bursar));

      return { ...s, east, inEast };
    }

    it("reports each class with its own totals", async () => {
      const { bursar, blue, east } = await billedAcrossTwoClasses("alpha");

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      const byId = Object.fromEntries(
        body.classes.map((c: { streamId: string }) => [c.streamId, c]),
      );

      expect(byId[blue.id]).toMatchObject({
        gradeLevelName: "Grade 4",
        studentCount: 3,
        outstandingCents: 3 * 1_800_000,
        owingCount: 3,
      });
      expect(byId[east.id]).toMatchObject({
        gradeLevelName: "Grade 5",
        studentCount: 2,
        outstandingCents: 2 * 2_200_000,
        owingCount: 2,
      });
    });

    it("agrees with the per-student figures it is aggregating", async () => {
      const { bursar, blue, kids } = await billedAcrossTwoClasses("alpha");

      // Part-pay one child, so the two views have something to disagree about.
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.studentId, kids[0].id));
      await post("/payments", {
        studentId: kids[0].id,
        invoiceId: invoice.id,
        method: "cash",
        amountCents: 500_000,
      }, jsonHeaders("alpha", bursar));

      const perClass = await (await app.request(`/balances/by-class`, {
        headers: tenantHeaders("alpha", bursar),
      })).json();
      const perStudent = await (await app.request(`/balances?streamId=${blue.id}`, {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      /*
       * The aggregation is a second expression of one rule. If the SQL and
       * `balancesFor` ever drift, one screen says a class owes X and another
       * says Y, with nothing in either to explain the gap.
       */
      const blueClass = perClass.classes.find(
        (c: { streamId: string }) => c.streamId === blue.id,
      );
      const summed = perStudent.balances
        .filter((b: { balanceCents: number }) => b.balanceCents > 0)
        .reduce((n: number, b: { balanceCents: number }) => n + b.balanceCents, 0);

      expect(blueClass.outstandingCents).toBe(summed);
      expect(blueClass.outstandingCents).toBe(2 * 1_800_000 + 1_300_000);
    });

    it("does not let a family in credit hide another family's debt", async () => {
      const { bursar, blue, kids } = await billedAcrossTwoClasses("alpha");

      // One family massively overpays.
      const [invoice] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.studentId, kids[0].id));
      await post("/payments", {
        studentId: kids[0].id,
        invoiceId: invoice.id,
        method: "bank",
        amountCents: 9_000_000,
      }, jsonHeaders("alpha", bursar));

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", bursar),
      })).json();
      const blueClass = body.classes.find(
        (c: { streamId: string }) => c.streamId === blue.id,
      );

      // Two children still owe 18,000 each. The credit must not net against
      // them, or the dashboard understates what is missing.
      expect(blueClass.outstandingCents).toBe(2 * 1_800_000);
      expect(blueClass.owingCount).toBe(2);
      // `netCents` is the un-netted figure, and is legitimately negative here.
      expect(blueClass.netCents).toBeLessThan(0);
    });

    it("excludes a student who has left", async () => {
      const { school, bursar, blue, kids } = await billedAcrossTwoClasses("alpha");

      await post(`/students/${kids[0].id}/exit`, {
        status: "transferred_out",
        exitedOn: "2026-02-01",
      }, jsonHeaders("alpha", await signInAt(school.id, "admin")));

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", bursar),
      })).json();
      const blueClass = body.classes.find(
        (c: { streamId: string }) => c.streamId === blue.id,
      );

      // A withdrawn pupil on a class list inflates every figure on the
      // dashboard — and their enrollment is closed, so they are in no class.
      expect(blueClass.studentCount).toBe(2);
      expect(blueClass.outstandingCents).toBe(2 * 1_800_000);
    });

    it("shows a class with nobody in it rather than dropping it", async () => {
      const { school, bursar } = await billedAcrossTwoClasses("alpha");
      const empty = await makeStream(school, 9, "Junior");

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      // A dashboard meant to cover the school must not silently omit a class.
      const emptyClass = body.classes.find(
        (c: { streamId: string }) => c.streamId === empty.id,
      );
      expect(emptyClass).toMatchObject({ studentCount: 0, outstandingCents: 0 });
    });

    it("puts the worst class first within a grade, as its docs promise", async () => {
      const { school, bursar, blue, term1 } = await billedAcrossTwoClasses("alpha");
      const east4 = await makeStream(school, 4, "Aardvark");

      // Same grade as Blue, alphabetically first, but owing more.
      for (const n of ["2026/020", "2026/021", "2026/022", "2026/023"]) {
        await makeStudent(school, n, {
          givenName: `Extra${n.slice(-3)}`,
          streamId: east4.id,
          boardingStatus: "day",
        });
      }
      await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar));

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      const grade4 = body.classes.filter(
        (c: { gradeLevelName: string }) => c.gradeLevelName === "Grade 4",
      );

      /*
       * The response description said "worst first within each grade" while
       * the query sorted by name — so a dashboard built against the documented
       * contract would have shown the wrong class at the top, which is the one
       * a bursar acts on.
       */
      expect(grade4[0].streamId).toBe(east4.id);
      expect(grade4[0].outstandingCents).toBeGreaterThan(grade4[1].outstandingCents);
      expect(grade4[1].streamId).toBe(blue.id);
    });

    it("orders by grade, so the dashboard reads like a school", async () => {
      const { bursar } = await billedAcrossTwoClasses("alpha");

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      const sequences = body.classes.map(
        (c: { gradeLevelSequence: number }) => c.gradeLevelSequence,
      );
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    });

    it("totals the school, not just the page", async () => {
      const { bursar } = await billedAcrossTwoClasses("alpha");

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      expect(body.totalStudentCount).toBe(5);
      expect(body.totalOwingCount).toBe(5);
      expect(body.totalOutstandingCents).toBe(3 * 1_800_000 + 2 * 2_200_000);
    });

    it("shows one school none of another's classes", async () => {
      await billedAcrossTwoClasses("alpha");
      const beta = await seed("beta");

      const body = await (await app.request("/balances/by-class", {
        headers: tenantHeaders("beta", beta.bursar),
      })).json();

      // Beta has one class, seeded but never billed.
      expect(body.classes.every((c: { outstandingCents: number }) => c.outstandingCents === 0)).toBe(true);
      expect(body.totalOutstandingCents).toBe(0);
    });

    it("403s a teacher", async () => {
      const { school } = await billedAcrossTwoClasses("alpha");
      const teacher = await signInAt(school.id, "teacher");

      const res = await app.request("/balances/by-class", {
        headers: tenantHeaders("alpha", teacher),
      });

      expect(res.status).toBe(403);
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

    it("totals outstanding across the whole school, not just one page", async () => {
      const { bursar, term1, setFees, school } = await seed("alpha");
      await setFees([TUITION]);
      const blue = await makeStream(school, 6, "Extra");

      // Five more children, so the roll exceeds a deliberately small page.
      for (let i = 10; i < 15; i += 1) {
        await makeStudent(school, `2026/0${i}`, {
          givenName: `Extra${i}`,
          streamId: blue.id,
          boardingStatus: "day",
        });
      }
      await post("/fee-structures", {
        termId: term1.id,
        gradeLevelId: school.gradeLevels.find(g => g.sequence === 6)!.id,
        boardingStatus: "day",
        items: [TUITION],
      }, jsonHeaders("alpha", bursar));

      await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar));

      const page = await (await app.request("/balances?limit=2", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      // The page is two rows; the figure a head reads is the school's. When
      // this was computed from the page it silently meant "what the first two
      // families owe" — a smaller number that looks just as plausible.
      expect(page.balances).toHaveLength(2);
      expect(page.totalOutstandingCents).toBe(8 * 1_800_000);
    });

    it("pages the outstanding-only invoice filter, not the page", async () => {
      const { bursar, kids, term1, setFees } = await seed("alpha");
      await setFees([TUITION]);
      await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar));

      // Settle one of the three in full.
      const [settled] = await db
        .select()
        .from(invoices)
        .where(eq(invoices.studentId, kids[0].id));
      await post("/payments", {
        studentId: kids[0].id,
        invoiceId: settled.id,
        method: "cash",
        amountCents: 1_800_000,
      }, jsonHeaders("alpha", bursar));

      const res = await (await app.request("/invoices?outstandingOnly=true", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      // `total` has to count what the filter matched. Filtering a page after
      // the fact left it counting invoices the filter had just removed, so
      // paging through the result never terminated where the caller expected.
      expect(res.invoices).toHaveLength(2);
      expect(res.total).toBe(2);
      expect(res.invoices.every((i: { outstandingCents: number }) => i.outstandingCents > 0)).toBe(true);
    });

    it("agrees with lib/balances about which invoices are outstanding", async () => {
      const { bursar, term1, setFees } = await seed("alpha");
      await setFees([TUITION]);
      await post("/invoices/generate", {
        termId: term1.id,
        issuedOn: "2026-01-06",
      }, jsonHeaders("alpha", bursar));

      const [settled, partial, voided] = await db.select().from(invoices);

      await post("/payments", {
        studentId: settled.studentId,
        invoiceId: settled.id,
        method: "cash",
        amountCents: 1_800_000,
      }, jsonHeaders("alpha", bursar));

      await post("/payments", {
        studentId: partial.studentId,
        invoiceId: partial.id,
        method: "cash",
        amountCents: 800_000,
      }, jsonHeaders("alpha", bursar));

      // Paid in full and then voided: outstanding must be zero, not negative.
      await post("/payments", {
        studentId: voided.studentId,
        invoiceId: voided.id,
        method: "cash",
        amountCents: 1_800_000,
      }, jsonHeaders("alpha", bursar));
      await post(`/invoices/${voided.id}/void`, { reason: "duplicate" }, jsonHeaders("alpha", bursar));

      const filtered = await (await app.request("/invoices?outstandingOnly=true", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      /*
       * The filter moved into SQL for paging; `lib/balances` still computes the
       * figure the response reports. Those are two expressions of one rule, and
       * the failure mode if they drift is silent — an invoice listed as
       * outstanding showing zero outstanding, or a debt missing from the list a
       * bursar works through.
       */
      expect(filtered.invoices.map((i: { id: string }) => i.id)).toEqual([partial.id]);
      expect(filtered.total).toBe(1);
      expect(filtered.invoices[0].outstandingCents).toBe(1_000_000);

      // And every invoice the filter excluded really does owe nothing.
      const everything = await (await app.request("/invoices?includeVoided=true", {
        headers: tenantHeaders("alpha", bursar),
      })).json();

      const excluded = everything.invoices.filter(
        (i: { id: string }) => i.id !== partial.id,
      );
      expect(excluded).toHaveLength(2);
      for (const invoice of excluded)
        expect(invoice.outstandingCents).toBe(0);
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
