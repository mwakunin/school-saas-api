import env from "@/env";

import type { SchoolContext } from "./01-school";
import type { Register, SeededPupil } from "./03-students";

import { day, instant, TERM_OFFSETS } from "./lib/calendar";
import { Api } from "./lib/client";
import { Rng } from "./lib/random";

/**
 * Fees, invoices, and the reconciliation queue that sells the product.
 *
 * This is the part a bursar is currently doing by hand — reading M-Pesa
 * messages off a phone and ticking names in a book — so it carries the
 * demo. The arrears have to be aged, the queue has to have real mistakes in
 * it, and reconciling one has to work while somebody is watching.
 */

/**
 * Termly fees for a modest private primary in the Nairobi metro.
 *
 * KES 12,000–25,000 a term, which is the tier CLAUDE.md §8 names. Amounts a
 * head does not recognise are as bad as names they do not recognise: too high
 * and the product is for somebody else, too low and it looks unserious.
 *
 * Cents, and whole shillings — the database CHECK refuses anything else,
 * because M-Pesa only moves whole shillings.
 */
const KES = (shillings: number) => shillings * 100;

interface FeePlan {
  grades: number[];
  boardingStatus: "day" | "boarder";
  items: Array<{ name: string; amountCents: number; isOptional?: boolean }>;
}

const FEE_PLANS: FeePlan[] = [
  {
    grades: [1, 2, 3],
    boardingStatus: "day",
    items: [
      { name: "Tuition", amountCents: KES(9000) },
      { name: "Activity fee", amountCents: KES(1500) },
      { name: "Examinations", amountCents: KES(1500) },
      // Optional items are NOT billed in bulk (CLAUDE.md §5.7) — they are
      // added per student below, for the families that actually take them.
      { name: "Lunch", amountCents: KES(3500), isOptional: true },
      { name: "Transport", amountCents: KES(4500), isOptional: true },
    ],
  },
  {
    grades: [4, 5, 6],
    boardingStatus: "day",
    items: [
      { name: "Tuition", amountCents: KES(11_500) },
      { name: "Activity fee", amountCents: KES(2000) },
      { name: "Examinations", amountCents: KES(1500) },
      { name: "Lunch", amountCents: KES(3500), isOptional: true },
      { name: "Transport", amountCents: KES(4500), isOptional: true },
    ],
  },
  {
    grades: [7, 8, 9],
    boardingStatus: "day",
    items: [
      { name: "Tuition", amountCents: KES(13_500) },
      { name: "Activity fee", amountCents: KES(2500) },
      { name: "Examinations", amountCents: KES(2000) },
      { name: "Lunch", amountCents: KES(3500), isOptional: true },
    ],
  },
  {
    grades: [7, 8, 9],
    boardingStatus: "boarder",
    items: [
      { name: "Tuition", amountCents: KES(13_500) },
      { name: "Boarding", amountCents: KES(9000) },
      { name: "Activity fee", amountCents: KES(2500) },
    ],
  },
];

export interface FeesResult {
  invoicesGenerated: number;
  paymentsRecorded: number;
  confirmationsReceived: number;
  autoAllocated: number;
  stillUnmatched: number;
  /** The family whose arrears should make a head wince. */
  alarming: { admissionNumber: string; name: string; balanceCents: number };
}

/**
 * Every invoice for a term, indexed by student.
 *
 * One paged read per term instead of a lookup per child. The N+1 version was
 * three hundred round trips per term and it showed — and `limit` caps at 200,
 * so a school this size needs the paging anyway.
 */
async function invoicesByStudent(api: Api, termId: string) {
  const byStudent = new Map<string, { id: string; totalCents: number }>();
  let offset = 0;

  for (;;) {
    const page = await api.get(
      `/invoices?termId=${termId}&limit=200&offset=${offset}`,
    );
    for (const invoice of page.invoices)
      byStudent.set(invoice.studentId, invoice);

    offset += page.invoices.length;
    if (page.invoices.length === 0 || offset >= page.total)
      break;
  }

  return byStudent;
}

export async function seedFees(
  ctx: SchoolContext,
  register: Register,
): Promise<FeesResult> {
  const rng = new Rng(555_123);
  const bursar = ctx.api("bursar");

  // The webhook is unauthenticated and carries no tenant host — the token in
  // the path is what establishes the school (CLAUDE.md §5.8).
  const safaricom = new Api(env.ROOT_DOMAIN);

  /*
   * The alarming balance is CHOSEN, not hoped for.
   *
   * The first version picked whichever pupil happened to end up furthest
   * behind, and got KES 10,500 — a number no head would look at twice. §8 asks
   * for "one alarming one" because that is what turns "we should chase fees"
   * into "we should chase THAT one", and an emergent worst case is not
   * reliably alarming.
   *
   * A junior-school boarder is the right shape: the most expensive place in
   * the school, unpaid across all three terms. They are held out of every
   * payment run below.
   */
  const alarmingPupil = register.pupils.find(
    p => p.gradeSequence === 8 && p.boardingStatus === "boarder",
  ) ?? register.pupils.find(p => p.boardingStatus === "boarder")!;

  // ---------------------------------------------------------------- structures
  for (const term of ctx.terms) {
    for (const plan of FEE_PLANS) {
      for (const sequence of plan.grades) {
        const grade = ctx.gradeLevels.find(g => g.sequence === sequence)!;
        await bursar.post("/fee-structures", {
          termId: term.id,
          gradeLevelId: grade.id,
          boardingStatus: plan.boardingStatus,
          items: plan.items,
        });
      }
    }
  }

  // ------------------------------------------------------------------ invoices
  let invoicesGenerated = 0;
  for (const term of ctx.terms) {
    const offsets = TERM_OFFSETS.find(t => t.number === term.number)!;
    const result = await bursar.post("/invoices/generate", {
      termId: term.id,
      // Issued in the first week, due three weeks in — which is what makes the
      // current term's unpaid invoices genuinely overdue rather than merely
      // recent.
      issuedOn: day(offsets.startsOn + 2),
      dueOn: day(offsets.startsOn + 21),
    });
    invoicesGenerated += result.created;
  }

  /*
   * Optional items, per family.
   *
   * Roughly a third take lunch and fewer take transport, which is what makes
   * two children in the same class owe different amounts — and why invoicing
   * every child for a bus they do not ride costs more trust than it collects.
   */
  const currentTerm = ctx.terms.find(t => t.number === 3)!;
  const currentInvoices = await invoicesByStudent(bursar, currentTerm.id);
  const extrasFor = new Map<string, number>();

  for (const pupil of register.pupils) {
    if (pupil.boardingStatus === "boarder")
      continue;

    let extra = 0;
    const invoice = currentInvoices.get(pupil.id);
    if (!invoice)
      continue;

    if (rng.chance(0.35)) {
      await bursar.post(`/invoices/${invoice.id}/lines`, {
        description: "Lunch",
        amountCents: KES(3500),
      });
      extra += KES(3500);
    }
    if (pupil.gradeSequence <= 6 && rng.chance(0.18)) {
      await bursar.post(`/invoices/${invoice.id}/lines`, {
        description: "Transport",
        amountCents: KES(4500),
      });
      extra += KES(4500);
    }

    /*
     * One bursary, as a negative line.
     *
     * CLAUDE.md §5.7 handles discounts this way, and a demo without one
     * invites the question "what about the children whose fees we waive?" with
     * no answer on screen.
     */
    if (rng.chance(0.03)) {
      await bursar.post(`/invoices/${invoice.id}/lines`, {
        description: "Bursary — board of management",
        amountCents: -KES(5000),
      });
      extra -= KES(5000);
    }

    extrasFor.set(pupil.id, extra);
  }

  // ------------------------------------------------------------------ payments
  /*
   * The two finished terms are mostly settled, and settled the boring way.
   *
   * Recorded as bank and cash rather than replayed as M-Pesa confirmations:
   * these are historic, already reconciled, and posting seven hundred more
   * callbacks would triple the seed's runtime to show nothing the current
   * term does not show better.
   */
  let paymentsRecorded = 0;
  const arrears = new Set<string>();

  for (const term of ctx.terms.filter(t => t.number <= 2)) {
    const offsets = TERM_OFFSETS.find(t => t.number === term.number)!;
    const termInvoices = await invoicesByStudent(bursar, term.id);

    for (const pupil of register.pupils) {
      if (pupil.id === alarmingPupil.id) {
        arrears.add(pupil.id);
        continue;
      }

      const invoice = termInvoices.get(pupil.id);
      if (!invoice)
        continue;

      const roll = rng.next();
      // A tenth of families end a term still owing something, and a twentieth
      // pay nothing at all — which is what gives the arrears an age.
      const fraction = roll < 0.86 ? 1 : roll < 0.96 ? rng.next() * 0.7 + 0.2 : 0;
      if (fraction === 0) {
        arrears.add(pupil.id);
        continue;
      }

      const amountCents = Math.round((invoice.totalCents * fraction) / 100) * 100;
      if (amountCents <= 0)
        continue;

      await bursar.post("/payments", {
        studentId: pupil.id,
        invoiceId: invoice.id,
        method: rng.chance(0.7) ? "bank" : "cash",
        amountCents,
        reference: `SLIP${rng.int(100_000, 999_999)}`,
        receivedAt: instant(offsets.startsOn + rng.int(3, 40)).toISOString(),
      });
      paymentsRecorded += 1;

      if (fraction < 1)
        arrears.add(pupil.id);
    }
  }

  // ------------------------------------------------------- the current term, by M-Pesa
  /*
   * This term's money arrives the way it really does: as C2B confirmations
   * posted to the school's callback URL, matched afterwards.
   *
   * Through the webhook rather than by writing rows, because the whole
   * reconciliation story depends on the raw confirmation existing separately
   * from the ledger entry — that separation is what makes a mis-allocation
   * reversible and "where did this KES 15,000 go" answerable.
   */
  let receipt = 7_000_000;
  const nextReceipt = () => `SJ${(receipt++).toString(36).toUpperCase()}${rng.int(10, 99)}`;

  const confirmation = (input: {
    reference: string;
    amountCents: number;
    payer: string;
    daysAgo: number;
    msisdn?: string;
  }) => {
    const when = instant(-input.daysAgo, rng.int(7, 19));
    const pad = (n: number) => String(n).padStart(2, "0");
    // Daraja's TransTime: YYYYMMDDHHmmss, East Africa Time.
    const eat = new Date(when.getTime() + 3 * 60 * 60 * 1000);
    const transTime = [
      eat.getUTCFullYear(),
      pad(eat.getUTCMonth() + 1),
      pad(eat.getUTCDate()),
      pad(eat.getUTCHours()),
      pad(eat.getUTCMinutes()),
      pad(eat.getUTCSeconds()),
    ].join("");

    return safaricom.post(
      `/webhooks/mpesa/c2b/${ctx.callbackToken}/confirmation`,
      {
        TransactionType: "Pay Bill",
        TransID: nextReceipt(),
        TransTime: transTime,
        TransAmount: (input.amountCents / 100).toFixed(2),
        BusinessShortCode: "600100",
        BillRefNumber: input.reference,
        MSISDN: input.msisdn ?? `2547${rng.int(10_000_000, 99_999_999)}`,
        FirstName: input.payer.split(" ")[0],
        LastName: input.payer.split(" ").slice(-1)[0],
      },
    );
  };

  let confirmationsReceived = 0;
  const payingThisTerm = rng.shuffle(register.pupils).slice(0, 140);

  for (const pupil of payingThisTerm) {
    if (pupil.id === register.leaver.id || pupil.id === alarmingPupil.id)
      continue;

    const invoice = currentInvoices.get(pupil.id);
    if (!invoice)
      continue;

    // Part payment is the norm mid-term — a family pays what they have.
    const fraction = rng.chance(0.45) ? 1 : rng.next() * 0.6 + 0.25;
    const amountCents = Math.round((invoice.totalCents * fraction) / 100) * 100;
    if (amountCents <= 0)
      continue;

    await confirmation({
      reference: pupil.admissionNumber,
      amountCents,
      payer: `${pupil.name.givenName} ${pupil.name.familyName}`,
      daysAgo: rng.int(1, 34),
    });
    confirmationsReceived += 1;
  }

  /*
   * And the ones that will not match. CLAUDE.md §8 asks for five or six, and
   * names three of them.
   *
   * Every one of these is a real thing parents do. None of them is fuzzy-
   * matchable on purpose: matching is strict (CLAUDE.md §5.8) because a wrong
   * automatic allocation puts money on another family's account where nobody
   * is looking for it. The queue offers near misses as suggestions instead,
   * and reconciling one of these live is the moment the demo lands.
   */
  const stuck = rng.shuffle(register.pupils.filter(p => p.gradeSequence >= 2)).slice(0, 6);
  const broken = [
    // §8's example: the prefix a parent remembers, not the number on the file.
    { reference: "ADM 118", note: "wrote the admission prefix instead of the number" },
    // Truncated — the year dropped off.
    { reference: stuck[1].admissionNumber.split("/")[1], note: "typed only the serial" },
    /*
     * An older sibling's number, from an intake this school no longer holds.
     *
     * 2014 and not 2019: intake years run back to 2018 for a Grade 9 pupil, so
     * a 2019 reference could land on a real Grade 8 child as class sizes move.
     * A reference that matched by accident would allocate real money to the
     * wrong family — which is the exact failure strict matching exists to
     * prevent, reintroduced by the seed.
     */
    { reference: "2014/044", note: "used a sibling's old number" },
    // The reference box filled with a phone number.
    { reference: "0722418330", note: "typed their own phone number" },
    // The child's name, which is what the box asks for at some other schools.
    {
      reference: `${stuck[3].name.givenName} ${stuck[3].name.familyName}`.toUpperCase(),
      note: "typed the child's name",
    },
    // Nothing at all.
    { reference: "", note: "left the reference blank" },
  ];

  for (const [index, entry] of broken.entries()) {
    await confirmation({
      reference: entry.reference,
      amountCents: KES(rng.int(30, 180) * 100),
      payer: `${stuck[index].name.givenName} ${stuck[index].name.familyName}`,
      daysAgo: rng.int(1, 12),
    });
    confirmationsReceived += 1;
  }

  /*
   * Run the matcher, the way the scheduled sweep does.
   *
   * Keyset-paged, so a backlog deeper than one batch is worked all the way
   * through rather than re-examining the stuck rows at the front for ever.
   */
  let autoAllocated = 0;
  let cursor: string | null = null;
  do {
    const pass: {
      allocated: number;
      remaining: number;
      nextCursor: string | null;
    } = await bursar.post(
      "/mpesa/transactions/match",
      cursor ? { after: cursor } : {},
    );
    autoAllocated += pass.allocated;
    cursor = pass.nextCursor;
  } while (cursor);

  const { transactions: unmatched } = await bursar.get(
    "/mpesa/transactions?status=unmatched&limit=200",
  );

  // The family held out of every payment run above: three terms of boarding
  // fees, nothing paid against any of them.
  /*
   * Scoped by class, then found by id.
   *
   * `/balances` filters by stream and grade and has no per-student parameter —
   * an unknown query key is simply ignored, so `?studentId=` silently returned
   * the whole school and this read the first row of it. The demo then advised
   * chasing a family KES 1,500 in CREDIT.
   */
  const { balances } = await bursar.get(
    `/balances?streamId=${alarmingPupil.streamId}&limit=500`,
  );
  const alarmingBalance = balances.find(
    (b: { studentId: string }) => b.studentId === alarmingPupil.id,
  );

  if (!alarmingBalance || alarmingBalance.balanceCents <= 0) {
    throw new Error(
      `The alarming family owes ${alarmingBalance?.balanceCents ?? "nothing"}, `
      + "which is not alarming. Something is holding them out of arrears.",
    );
  }

  return {
    invoicesGenerated,
    paymentsRecorded,
    confirmationsReceived,
    autoAllocated,
    stillUnmatched: unmatched.length,
    alarming: {
      admissionNumber: alarmingPupil.admissionNumber,
      name: `${alarmingPupil.name.givenName} ${alarmingPupil.name.familyName}`,
      balanceCents: alarmingBalance.balanceCents,
    },
  };
}

/** Re-exported so the runner can report what a term costs here. */
export { FEE_PLANS };
export type { SeededPupil };
