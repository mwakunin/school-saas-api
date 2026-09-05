import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import {
  academicYears,
  invoices,
  payments,
  reportCards,
  schools,
  students,
  terms,
  transitionCertificates,
} from "@/db/schema";

import type { VerifyDocumentRoute } from "./verify.routes";

/**
 * The owner connection, and this is one of the few places that is right.
 *
 * There is no tenant to resolve: whoever is checking a document holds a piece
 * of paper and nothing else — no session, no subdomain. The code IS the
 * lookup, exactly as the M-Pesa callback token is for a Safaricom callback,
 * and `db-access.test.ts` carries this file in its allowlist for that reason.
 *
 * What keeps it safe is that the query can only ever be BY code. There is no
 * parameter here that could widen a result set, so a caller cannot ask for
 * anything except the one document they already have.
 */

/**
 * The school a document was issued by.
 *
 * The only piece not held in a snapshot, and the only live read left here. A
 * school renaming itself is both rare and unlike the other changes: the
 * institution is the same one, and telling a verifier its current name is more
 * useful than its old one. Everything ABOUT the child comes from the frozen
 * document.
 */
async function schoolFor(schoolId: string) {
  const [row] = await db
    .select({ name: schools.name, county: schools.county })
    .from(schools)
    .where(eq(schools.id, schoolId))
    .limit(1);

  return row ?? null;
}

/**
 * The student and class as the document RECORDED them, not as they are now.
 *
 * This used to join through to the live student and stream rows, which quietly
 * broke the promise the endpoint makes. A child who transferred to another
 * class, whose name was corrected, or whose stream was renamed between the
 * document being printed and somebody checking it would have been verified
 * against details that no longer matched the paper in their hand — the exact
 * failure a snapshot exists to prevent (rule 7), reintroduced by the verifier.
 */
interface IssuedContext {
  studentName: string;
  admissionNumber: string;
  className: string | null;
}

function contextFromSnapshot(snapshot: Record<string, unknown>): IssuedContext | null {
  const student = snapshot.student as
    | { name?: string; admissionNumber?: string }
    | undefined;

  if (!student?.name || !student.admissionNumber)
    return null;

  const held = (snapshot.class ?? snapshot.completed) as
    | { gradeLevelName?: string; streamName?: string }
    | undefined;

  return {
    studentName: student.name,
    admissionNumber: student.admissionNumber,
    className: held?.gradeLevelName
      ? `${held.gradeLevelName} ${held.streamName ?? ""}`.trim()
      : null,
  };
}

async function termFor(termId: string) {
  const [row] = await db
    .select({ number: terms.number, year: academicYears.year })
    .from(terms)
    .innerJoin(academicYears, eq(terms.academicYearId, academicYears.id))
    .where(eq(terms.id, termId))
    .limit(1);

  return row ?? null;
}

export const verifyDocument: AppRouteHandler<VerifyDocumentRoute> = async (c) => {
  const { code } = c.req.valid("param");

  const notFound = () =>
    c.json(
      {
        message: "No document with that code was issued by any school here.",
        verified: false as const,
      },
      HttpStatusCodes.NOT_FOUND,
    );

  // --------------------------------------------------------------- report card
  const [card] = await db
    .select()
    .from(reportCards)
    .where(eq(reportCards.verificationCode, code))
    .limit(1);

  if (card) {
    const snapshot = card.snapshot as Record<string, unknown>;
    const context = contextFromSnapshot(snapshot);
    const school = await schoolFor(card.schoolId);

    if (!context || !school)
      return notFound();

    const term = await termFor(card.termId);

    /*
     * Straight from the snapshot, never recomputed.
     *
     * Somebody comparing this against paper has to see what was PRINTED,
     * including where the marks behind it have since been corrected — a
     * verifier that quietly showed today's figures would report a genuine
     * document as a forgery.
     */
    return c.json({
      documentType: "report_card" as const,
      school,
      student: {
        name: context.studentName,
        admissionNumber: context.admissionNumber,
      },
      term: term ? { number: term.number, year: term.year } : null,
      className: context.className,
      issuedAt: card.finalisedAt?.toISOString() ?? null,
      summary: {
        learningAreas: snapshot.learningAreas ?? [],
        levelReduction: snapshot.levelReduction ?? null,
        showsPositions: snapshot.showsPositions ?? null,
        classTeacherComment: card.classTeacherComment,
        headComment: card.headComment,
        attendancePresent: card.attendancePresent,
        attendanceTotal: card.attendanceTotal,
      },
      status: "valid" as const,
      statusReason: null,
    }, HttpStatusCodes.OK);
  }

  // ----------------------------------------------------------- payment receipt
  const [receipt] = await db
    .select({
      payment: payments,
      schoolName: schools.name,
      county: schools.county,
      givenName: students.givenName,
      familyName: students.familyName,
      admissionNumber: students.admissionNumber,
      termId: invoices.termId,
    })
    .from(payments)
    .innerJoin(students, eq(payments.studentId, students.id))
    .innerJoin(schools, eq(payments.schoolId, schools.id))
    .leftJoin(invoices, eq(payments.invoiceId, invoices.id))
    .where(eq(payments.verificationCode, code))
    .limit(1);

  if (receipt) {
    /*
     * A receipt has no snapshot, and does not need one.
     *
     * What it asserts — an amount, a method, a date — lives on the payment row
     * itself and never changes; the row is reversed, never edited. The child's
     * name is read live for the same reason a school's is: a corrected
     * spelling should show as corrected, and the admission number on the paper
     * is what actually identifies the account.
     */
    const term = receipt.termId ? await termFor(receipt.termId) : null;
    const reversed = receipt.payment.reversedAt !== null;

    return c.json({
      documentType: "payment_receipt" as const,
      school: { name: receipt.schoolName, county: receipt.county },
      student: {
        name: `${receipt.givenName} ${receipt.familyName}`,
        admissionNumber: receipt.admissionNumber,
      },
      term: term ? { number: term.number, year: term.year } : null,
      className: null,
      issuedAt: receipt.payment.receivedAt.toISOString(),
      summary: {
        amountCents: receipt.payment.amountCents,
        method: receipt.payment.method,
        reference: receipt.payment.reference,
      },
      /*
       * A reversed receipt is authentic AND no longer good.
       *
       * Answering only "verified" would be a true statement that misleads —
       * the paper is real, the money is not on the account any more, and the
       * person checking is very often checking exactly because of that.
       */
      status: reversed ? ("withdrawn" as const) : ("valid" as const),
      statusReason: reversed
        ? receipt.payment.reversalReason ?? "This payment was reversed."
        : null,
    }, HttpStatusCodes.OK);
  }

  // ---------------------------------------------------- transition certificate
  const [certificate] = await db
    .select()
    .from(transitionCertificates)
    .where(eq(transitionCertificates.verificationCode, code))
    .limit(1);

  if (certificate) {
    const snapshot = certificate.snapshot as Record<string, unknown>;
    const context = contextFromSnapshot(snapshot);
    const school = await schoolFor(certificate.schoolId);

    if (!context || !school)
      return notFound();

    const term = await termFor(certificate.termId);

    return c.json({
      documentType: "transition_certificate" as const,
      school,
      student: {
        name: context.studentName,
        admissionNumber: context.admissionNumber,
      },
      term: term ? { number: term.number, year: term.year } : null,
      className: context.className,
      issuedAt: certificate.issuedAt.toISOString(),
      summary: snapshot,
      status: "valid" as const,
      statusReason: null,
    }, HttpStatusCodes.OK);
  }

  return notFound();
};
