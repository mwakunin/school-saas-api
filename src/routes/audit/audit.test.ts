import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import type { TestUser } from "@/test/helpers";

import app from "@/app";
import db, { appPool } from "@/db";
import { auditLog } from "@/db/schema";
import { pgErrorCode } from "@/lib/db-errors";
import {
  makeInvoice,
  makeSchool,
  makeStream,
  makeStudent,
  resetDb,
  signInAt,
  tenantHeaders,
} from "@/test/helpers";

/**
 * Who changed a mark, who reversed a payment, who released a report card.
 *
 * CLAUDE.md §6 names those three and calls this both a safeguard and a sales
 * point. It is only either if two things hold: the entry commits with the
 * action it describes, and nobody — including the application — can go back
 * and change it afterwards.
 */
function jsonHeaders(subdomain: string, user: TestUser) {
  return { "content-type": "application/json", ...tenantHeaders(subdomain, user) };
}

function post(path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

async function seed(subdomain: string) {
  const school = await makeSchool({ subdomain });
  const blue = await makeStream(school, 4, "Blue");
  const admin = await signInAt(school.id, "admin");
  const bursar = await signInAt(school.id, "bursar");
  const student = await makeStudent(school, "2026/001", {
    givenName: "Wanjiku",
    streamId: blue.id,
  });

  return { school, blue, admin, bursar, student, subdomain };
}

describe("audit log", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("what it records", () => {
    it("names who reversed a payment and why", async () => {
      const ctx = await seed("alpha");

      const payment = await (await post("/payments", {
        studentId: ctx.student.id,
        method: "cash",
        amountCents: 500_000,
      }, jsonHeaders("alpha", ctx.bursar))).json();

      await post(`/payments/${payment.id}/reverse`, {
        reason: "Recorded against the wrong child",
      }, jsonHeaders("alpha", ctx.bursar));

      const listed = await (await app.request(
        `/audit-log?entityType=payment&entityId=${payment.id}`,
        { headers: tenantHeaders("alpha", ctx.admin) },
      )).json();

      const reversal = listed.entries.find(
        (e: { action: string }) => e.action === "payment.reversed",
      );

      // "Who reversed this, and why" is what a head is asked when a family
      // says the money left their phone. The answer has to be in a screen.
      expect(reversal).toBeDefined();
      expect(reversal.actorId).toBe(ctx.bursar.id);
      expect(reversal.summary).toContain("wrong child");
      expect(reversal.detail.reason).toBe("Recorded against the wrong child");
    });

    it("records the invoice void alongside it", async () => {
      const ctx = await seed("alpha");
      const invoice = await makeInvoice(ctx.school, ctx.student, { totalCents: 1_500_000 });

      await post(`/invoices/${invoice.id}/void`, {
        reason: "Duplicate of the term's real invoice",
      }, jsonHeaders("alpha", ctx.bursar));

      const listed = await (await app.request("/audit-log?action=invoice.voided", {
        headers: tenantHeaders("alpha", ctx.admin),
      })).json();

      expect(listed.entries).toHaveLength(1);
      expect(listed.entries[0].entityId).toBe(invoice.id);
    });

    it("resolves the actor to a name, not an opaque id", async () => {
      const ctx = await seed("alpha");
      const invoice = await makeInvoice(ctx.school, ctx.student, { totalCents: 1_500_000 });
      await post(`/invoices/${invoice.id}/void`, {
        reason: "Duplicate",
      }, jsonHeaders("alpha", ctx.bursar));

      const listed = await (await app.request("/audit-log", {
        headers: tenantHeaders("alpha", ctx.admin),
      })).json();

      // A screen showing `f7bCmzho...` answers nobody's question, and being
      // readable by a head is the whole value of the table.
      expect(listed.entries[0]).toHaveProperty("actorName");
    });
  });

  describe("what makes it evidence", () => {
    it("cannot be edited by the runtime role", async () => {
      const ctx = await seed("alpha");
      const invoice = await makeInvoice(ctx.school, ctx.student, { totalCents: 1_500_000 });
      await post(`/invoices/${invoice.id}/void`, {
        reason: "Duplicate",
      }, jsonHeaders("alpha", ctx.bursar));

      const [entry] = await db.select().from(auditLog);

      /*
       * On the runtime connection, which is what the application actually
       * uses. A log the app can rewrite is evidence of nothing — and the
       * person who wishes an entry said something different is precisely the
       * person who must not be able to change it. The privilege simply is not
       * granted, so no handler bug can either.
       */
      const client = await appPool.connect();
      try {
        await client.query("SELECT set_config('app.school_id', $1, false)", [ctx.school.id]);

        const edit = await client
          .query(`UPDATE audit_log SET summary = 'nothing happened' WHERE id = $1`, [entry.id])
          .then(() => null, (e: unknown) => e);
        expect(pgErrorCode(edit)).toBe("42501");

        const remove = await client
          .query(`DELETE FROM audit_log WHERE id = $1`, [entry.id])
          .then(() => null, (e: unknown) => e);
        expect(pgErrorCode(remove)).toBe("42501");
      }
      finally {
        client.release();
      }

      const [unchanged] = await db.select().from(auditLog).where(eq(auditLog.id, entry.id));
      expect(unchanged.summary).toBe(entry.summary);
    });

    it("does not survive an action that was rolled back", async () => {
      const ctx = await seed("alpha");

      /*
       * The entry commits with the change or not at all.
       *
       * `withTenant` rolls the request transaction back on an error status, so
       * a failed reversal must leave no trace claiming it happened. An audit
       * log that recorded attempts as facts would be worse than none.
       */
      const res = await post("/payments/00000000-0000-0000-0000-000000000000/reverse", {
        reason: "Nothing to reverse",
      }, jsonHeaders("alpha", ctx.bursar));

      expect(res.status).toBe(404);

      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog);
      expect(n).toBe(0);
    });
  });

  describe("who may read it", () => {
    it("is the head's, not the bursar's", async () => {
      const ctx = await seed("alpha");

      // The people it is a check ON must not be the ones browsing it for what
      // was noticed.
      const res = await app.request("/audit-log", {
        headers: tenantHeaders("alpha", ctx.bursar),
      });
      expect(res.status).toBe(403);
    });

    it("shows one school none of another's entries", async () => {
      const alpha = await seed("alpha");
      const beta = await seed("beta");

      const invoice = await makeInvoice(beta.school, beta.student, { totalCents: 1_500_000 });
      await post(`/invoices/${invoice.id}/void`, {
        reason: "Duplicate",
      }, jsonHeaders("beta", beta.bursar));

      const listed = await (await app.request("/audit-log", {
        headers: tenantHeaders("alpha", alpha.admin),
      })).json();

      expect(listed.entries).toHaveLength(0);
      expect(listed.total).toBe(0);
    });
  });
});
