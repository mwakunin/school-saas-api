import { eq, sql } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it } from "vitest";

import db, { appDb } from "@/db";
import { mpesaTransactions, payments, schools } from "@/db/schema";
import {
  decodeCursor,
  encodeCursor,
  matchUnallocated,
  normaliseReference,
} from "@/lib/mpesa-matching";
import { makeSchool, makeStudent, resetDb } from "@/test/helpers";

/**
 * The matcher's paging, exercised at a batch size small enough to need it.
 *
 * The route sweeps 200 at a time, so a route-level test finishes in one pass
 * and proves nothing about what happens when a queue is deeper than a batch —
 * which is exactly where the first bounded version was broken.
 */
async function inTenant<T>(schoolId: string, fn: (db: never) => Promise<T>): Promise<T> {
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.school_id', ${schoolId}, true)`);
    return fn(tx as never);
  });
}

async function backlog(schoolId: string, rows: Array<[string, string, string]>) {
  for (const [id, reference, at] of rows) {
    await db.insert(mpesaTransactions).values({
      schoolId,
      transactionId: id,
      shortcode: "600638",
      accountReference: reference,
      msisdn: "254712345678",
      amountCents: 100_000,
      transactedAt: new Date(at),
      rawPayload: {},
      status: "unmatched",
    });
  }
}

describe("normaliseReference", () => {
  it.each([
    ["2026/118", "2026118"],
    ["2026-118", "2026118"],
    ["2026 118", "2026118"],
    ["2026_118", "2026118"],
    ["2026.118", "2026118"],
    ["adm/118", "ADM118"],
  ])("reduces %s to %s", (input, expected) => {
    // Normalises how a number was WRITTEN, never what it means — which is why
    // `ADM 118` still does not become `2026/118`.
    expect(normaliseReference(input)).toBe(expected);
  });
});

describe("match cursor", () => {
  it("round-trips", () => {
    const cursor = { transactedAt: new Date("2026-01-15T11:30:45.000Z"), id: crypto.randomUUID() };
    const decoded = decodeCursor(encodeCursor(cursor))!;

    expect(decoded.id).toBe(cursor.id);
    expect(decoded.transactedAt.toISOString()).toBe(cursor.transactedAt.toISOString());
  });

  it.each([
    ["empty", ""],
    ["not base64", "!!!"],
    ["missing the id", Buffer.from("2026-01-15T11:30:45.000Z").toString("base64url")],
    ["unparseable date", Buffer.from("yesterday|abc").toString("base64url")],
  ])("refuses a cursor that is %s", (_case, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});

describe("matchUnallocated paging", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("reaches a matchable row behind more unmatchable rows than fit in a batch", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    await db.update(schools).set({ mpesaShortcode: "600638" }).where(eq(schools.id, school.id));
    await makeStudent(school, "2026/500", { givenName: "Reachable" });

    /*
     * The regression this file exists for.
     *
     * A bounded sweep that always restarted from the oldest row could never
     * get past the front of the queue — and the front of a queue is, by
     * definition, the rows nothing could match. Every pass re-examined the
     * same batch, matched nothing, and still reported that more remained, so
     * a client told to "run again" looped for ever without progressing.
     */
    await backlog(school.id, [
      ["T1", "GIBBERISH-A", "2026-01-01T08:00:00Z"],
      ["T2", "GIBBERISH-B", "2026-01-02T08:00:00Z"],
      ["T3", "GIBBERISH-C", "2026-01-03T08:00:00Z"],
      ["T4", "2026/500", "2026-01-04T08:00:00Z"],
    ]);

    let after: { transactedAt: Date; id: string } | null = null;
    let passes = 0;
    const examined: number[] = [];

    do {
      const pass = await inTenant(school.id, db =>
        matchUnallocated(db, school.id, { batchSize: 2, after }));

      examined.push(pass.results.length);
      after = pass.nextCursor;
      passes += 1;
    } while (after && passes < 10);

    // Two rows a pass, and the fourth row was reached.
    expect(examined).toEqual([2, 2]);
    expect(passes).toBe(2);

    const paid = await db.select().from(payments);
    expect(paid).toHaveLength(1);
    expect(paid[0].reference).toBe("T4");
  });

  it("moves the cursor forward on every pass", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    await backlog(school.id, [
      ["U1", "NOPE-1", "2026-01-01T08:00:00Z"],
      ["U2", "NOPE-2", "2026-01-02T08:00:00Z"],
      ["U3", "NOPE-3", "2026-01-03T08:00:00Z"],
      ["U4", "NOPE-4", "2026-01-04T08:00:00Z"],
    ]);

    const first = await inTenant(school.id, db =>
      matchUnallocated(db, school.id, { batchSize: 2 }));
    const second = await inTenant(school.id, db =>
      matchUnallocated(db, school.id, { batchSize: 2, after: first.nextCursor }));

    // Nothing matched either time — which is the case that used to loop.
    expect(first.results.map(r => r.transactionId))
      .not
      .toEqual(second.results.map(r => r.transactionId));
    expect(second.nextCursor).toBeNull();
    expect(second.remaining).toBe(0);
  });

  it("counts what a further pass would examine, not the whole queue", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    await backlog(school.id, [
      ["W1", "NOPE-1", "2026-01-01T08:00:00Z"],
      ["W2", "NOPE-2", "2026-01-02T08:00:00Z"],
      ["W3", "NOPE-3", "2026-01-03T08:00:00Z"],
    ]);

    const pass = await inTenant(school.id, db =>
      matchUnallocated(db, school.id, { batchSize: 2 }));

    // Three unmatched rows remain in the queue, but only ONE is still ahead of
    // the cursor. Reporting three would say "run again" three times over and
    // never fall.
    expect(pass.remaining).toBe(1);
  });

  it("clears the cursor when the queue runs out, so the next run starts over", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    await backlog(school.id, [["V1", "NOPE", "2026-01-01T08:00:00Z"]]);

    const first = await inTenant(school.id, db =>
      matchUnallocated(db, school.id, { batchSize: 10 }));
    expect(first.nextCursor).toBeNull();

    // A confirmation arriving later must be picked up by the next sweep, which
    // is why a finished sweep clears the cursor rather than parking at the end.
    await makeStudent(school, "2026/777", { givenName: "New" });
    await backlog(school.id, [["V2", "2026/777", "2026-01-05T08:00:00Z"]]);

    const second = await inTenant(school.id, db =>
      matchUnallocated(db, school.id, { batchSize: 10 }));

    expect(second.results.filter(r => r.outcome.kind === "matched")).toHaveLength(1);
  });

  it("orders by id when two payments share a timestamp", async () => {
    const school = await makeSchool({ subdomain: "alpha" });
    // Two payments in the same second is ordinary at a school gate on fee day.
    // Without the id in the sort key the order is arbitrary, and a cursor
    // could skip one or repeat it for ever.
    await backlog(school.id, [
      ["S1", "NOPE-1", "2026-01-01T08:00:00Z"],
      ["S2", "NOPE-2", "2026-01-01T08:00:00Z"],
      ["S3", "NOPE-3", "2026-01-01T08:00:00Z"],
    ]);

    const seen = new Set<string>();
    let after: { transactedAt: Date; id: string } | null = null;
    let passes = 0;

    do {
      const pass = await inTenant(school.id, db =>
        matchUnallocated(db, school.id, { batchSize: 1, after }));

      for (const r of pass.results)
        seen.add(r.transactionId);

      after = pass.nextCursor;
      passes += 1;
    } while (after && passes < 10);

    // Every row seen exactly once, and the sweep terminated.
    expect(seen.size).toBe(3);
    expect(passes).toBeLessThan(10);
  });
});
