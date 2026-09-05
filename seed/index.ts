import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import db from "@/db";
import { schools } from "@/db/schema";

import { LOGINS, seedSchool, SUBDOMAIN } from "./01-school";
import { seedCurriculum } from "./02-curriculum";
import { seedStudents } from "./03-students";
import { seedHistory } from "./04-history";
import { seedFees } from "./05-fees";
import { seedCurrentTerm } from "./06-current";
import { seedLeavers } from "./07-leavers";
import { seedMessaging } from "./08-messaging";
import { TERM_DATES } from "./lib/calendar";
import { DEMO_PASSWORD } from "./lib/client";

/**
 * The demo tenant, built through the API from an empty database.
 *
 * CLAUDE.md §8 treats this as a product surface rather than throwaway
 * fixtures: it closes sales and doubles as an integration test. Both of those
 * only hold if it is honest — a special code path would drift from the real
 * one and embarrass somebody mid-presentation, and a seed that skipped
 * validation would stop being evidence that anything works.
 *
 * Nightly: drop the database, migrate, run this. Deterministic, so what a
 * presenter rehearsed against this morning is what they get this afternoon.
 */

export interface SeedSummary {
  subdomain: string;
  /** The term in progress, for callers that need to ask about it. */
  currentTermId: string;
  /**
   * This year's finished terms, oldest first.
   *
   * Ids rather than numbers: the demo now has a previous year too, so "term 3"
   * names two different terms and anything matching on the number alone picks
   * whichever sorts first.
   */
  finishedTermIds: string[];
  logins: Array<{ role: string; email: string; password: string }>;
  terms: typeof TERM_DATES;
  pupils: number;
  streams: number;
  assessments: number;
  reportCards: number;
  invoices: number;
  unmatched: number;
  certificates: number;
  graduated: number;
  auditEntries: number;
  /** The receipt the seed deliberately reverses. */
  reversedReceiptCode: string | null;
  smsQueued: number;
  /** The guardians with a child in more than one class. */
  siblingGuardianIds: string[];
  /** The arrears meant to make a head wince. */
  alarmingBalanceCents: number;
  script: string[];
}

export async function seedDemo(): Promise<SeedSummary> {
  const started = Date.now();
  const log = (step: string) =>
    // eslint-disable-next-line no-console
    console.log(`  ${String(Math.round((Date.now() - started) / 100) / 10).padStart(6)}s  ${step}`);

  log("school, terms, classes and staff");
  const ctx = await seedSchool();

  log("curriculum");
  const curriculum = await seedCurriculum(ctx);

  log("students, guardians and enrolments");
  const register = await seedStudents(ctx);

  log(`history for two finished terms (${register.pupils.length} pupils)`);
  const history = await seedHistory(ctx, curriculum, register, {
    // Report cards for the class the demo teacher teaches, plus the classes
    // the demo parent's children are in — the three screens anybody will
    // actually open. Finalising all fifteen classes would treble the runtime
    // to produce documents nobody in the room will look at.
    reportCardStreamIds: new Set([
      ctx.streams.find(s => s.sequence === 4 && s.name === "Blue")!.id,
      ...register.siblingGroups.flatMap(g => g.pupils.map(p => p.streamId)),
    ]),
  });

  log("fees, invoices and the M-Pesa queue");
  const fees = await seedFees(ctx, register);

  log("the term in progress");
  const current = await seedCurrentTerm(ctx, curriculum, register);

  log("last year's leavers and their certificates");
  const leavers = await seedLeavers(ctx, curriculum, register);

  log("a fee-reminder batch");
  const messaging = await seedMessaging(ctx);

  // Read back rather than counted as we go: the log is written by the handlers
  // themselves, so anything this claims has to come from the same place a head
  // would read it.
  const audit = await ctx.api("head").get("/audit-log?limit=1");

  const shillings = (cents: number) =>
    `KES ${(cents / 100).toLocaleString("en-KE")}`;

  return {
    subdomain: ctx.subdomain,
    currentTermId: ctx.terms.find(t => t.number === 3)!.id,
    finishedTermIds: ctx.terms.filter(t => t.number < 3).map(t => t.id),
    logins: Object.entries(LOGINS).map(([role, login]) => ({
      role,
      email: login.email,
      password: DEMO_PASSWORD,
    })),
    terms: TERM_DATES,
    pupils: register.pupils.length,
    streams: ctx.streams.length,
    assessments: history.assessments + current.published + 1,
    reportCards: history.reportCards,
    invoices: fees.invoicesGenerated,
    unmatched: fees.stillUnmatched,
    certificates: leavers.certificatesIssued,
    graduated: leavers.graduated,
    auditEntries: audit.total,
    reversedReceiptCode: fees.reversedReceiptCode,
    smsQueued: messaging.sent,
    siblingGuardianIds: register.siblingGroups.map(g => g.guardianId),
    alarmingBalanceCents: fees.alarming.balanceCents,

    /*
     * The running order, printed with the summary.
     *
     * A demo is a performance, and the details that make it land — which
     * reference to reconcile, which assessment is unpublished — are the ones
     * nobody can remember under pressure. Emitting them next to the data they
     * describe is what keeps the script and the database from drifting apart.
     */
    script: [
      `Sign in as the bursar at ${ctx.subdomain} and open the reconciliation queue.`,
      `  ${fees.stillUnmatched} payments are sitting unmatched — including one where the`,
      `  parent typed "ADM 118" instead of their child's admission number.`,
      `  Allocate it from the suggestions. That is the bursar's whole afternoon, done.`,
      ``,
      `Open outstanding balances by class. ${fees.alarming.name} (${fees.alarming.admissionNumber})`,
      `  owes ${shillings(fees.alarming.balanceCents)} across three terms — the one to chase first.`,
      ``,
      `As the class teacher, open "${current.unpublished.title}" in ${current.unpublished.streamName}.`,
      `  Marks are two thirds entered and it is NOT published, so it is absent`,
      `  from the term mean and from every released report card. Publish it and`,
      `  recompute: the means move.`,
      `  (The parent's side of this is not demonstrable yet — see below.)`,
      ``,
      `As the head, open a report card from last term. Positions and levels are frozen`,
      `  into it — change a mark behind it and reprint: the document does not move.`,
      ``,
      `Search the register for one of the sibling families. Two children, one guardian,`,
      `  one phone number, one fee reminder.`,
      ``,
      `Scan the QR on a report card, or open this certificate's link on a phone:`,
      `  ${leavers.sample.verificationUrl}`,
      `  It confirms ${leavers.sample.studentName}'s ${leavers.sample.milestone} against the`,
      `  frozen document. Change a mark behind it and check again: it does not move.`,
      ...(fees.reversedReceiptCode
        ? [
            ``,
            `Then verify the reversed receipt: /verify/${fees.reversedReceiptCode}`,
            `  It answers "withdrawn", not merely authentic — the paper is real and`,
            `  the money is not on the account. That is usually why somebody is checking.`,
          ]
        : []),
      ``,
      `Open the audit log as the head. ${audit.total} entries, including who reversed`,
      `  that payment and why. The bursar cannot open this screen, and neither the`,
      `  app nor a compromised handler can edit it — the runtime role has no UPDATE.`,
      ``,
      messaging.dryRun
        ? `SMS: the Grade 8 reminder was PREVIEWED, not sent — ${messaging.previewed} families,`
        : `SMS: ${messaging.sent} Grade 8 reminders sent, costing about`,
      messaging.dryRun
        ? `  about KES ${(messaging.estimatedCostCents / 100).toFixed(2)}. Set AT_USERNAME/AT_API_KEY`
        + ` (AT_ENV=sandbox) to populate the ledger.`
        : `  KES ${(messaging.estimatedCostCents / 100).toFixed(2)}. Every message is a row with its own cost.`,
      `  The preview is the DEFAULT: sending is what you opt into, because four`,
      `  hundred delivered messages cannot be recalled.`,
      ``,
      `NOT YET DEMONSTRABLE: the parent portal. The parent login is a real`,
      `  guardian membership, but no route serves a guardian their own child's`,
      `  marks, balance or report card — and nothing links a guardian record to`,
      `  a login. Do not promise this screen in a meeting.`,
    ],
  };
}

/** `pnpm seed:demo` — run against whatever DATABASE_URL points at. */
async function main() {
  // eslint-disable-next-line no-console
  const say = console.log;

  /*
   * Refuse to run on top of an existing demo.
   *
   * §8's reset is "drop and reseed", and this does not drop — it would fail
   * partway on the subdomain unique and leave a half-built school behind,
   * which is a worse thing to discover at 2am than a message. Saying so up
   * front costs one query.
   */
  const [existing] = await db
    .select({ id: schools.id })
    .from(schools)
    .where(eq(schools.subdomain, SUBDOMAIN));

  if (existing) {
    say(
      `\n  A school already exists at "${SUBDOMAIN}".`
      + "\n  The nightly reset drops the database and re-migrates before seeding;"
      + "\n  this command only seeds. Reset first, then run it again.\n",
    );
    return;
  }

  say("\nSeeding the demo tenant…\n");
  const summary = await seedDemo();

  say(`\n  ${summary.pupils} pupils in ${summary.streams} classes`);
  say(`  ${summary.assessments} assessments, ${summary.reportCards} released report cards`);
  say(`  ${summary.invoices} invoices, ${summary.unmatched} payments awaiting reconciliation\n`);

  say("  Terms:");
  for (const term of summary.terms) {
    say(`    ${term.number}. ${term.startsOn} to ${term.endsOn}${term.isCurrent ? "  (current)" : ""}`);
  }

  say(`\n  Logins at ${summary.subdomain}.<your domain>:`);
  for (const login of summary.logins)
    say(`    ${login.role.padEnd(8)} ${login.email}  /  ${login.password}`);

  say("\n  Running order:\n");
  for (const line of summary.script)
    say(`    ${line}`);
  say("");
}

/*
 * Only when run directly, so importing this from a test seeds nothing.
 *
 * Compared as a resolved path rather than by basename: matching on "index.ts"
 * would fire for any other entry point with that name, and a seed that ran
 * itself because something else was called index.ts would be a very confusing
 * afternoon.
 */
const runDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (runDirectly) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("\nSeed failed:\n", err);
      process.exit(1);
    },
  );
}

export { SUBDOMAIN };
