import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { AppRouteHandler } from "@/lib/types";

import db from "@/db";
import {
  academicYears,
  enrollments,
  gradeLevels,
  invoices,
  payments,
  reportCards,
  schools,
  streams,
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

/** What every document type answers with about the school and the child. */
async function contextFor(schoolId: string, enrollmentId: string) {
  const [row] = await db
    .select({
      schoolName: schools.name,
      county: schools.county,
      givenName: students.givenName,
      familyName: students.familyName,
      admissionNumber: students.admissionNumber,
      streamName: streams.name,
      gradeName: gradeLevels.name,
    })
    .from(enrollments)
    .innerJoin(students, eq(enrollments.studentId, students.id))
    .innerJoin(streams, eq(enrollments.streamId, streams.id))
    .innerJoin(gradeLevels, eq(streams.gradeLevelId, gradeLevels.id))
    .innerJoin(schools, eq(enrollments.schoolId, schools.id))
    .where(eq(enrollments.id, enrollmentId))
    .limit(1);

  if (!row || row.schoolName === undefined)
    return null;

  void schoolId;
  return row;
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
    const context = await contextFor(card.schoolId, card.enrollmentId);
    if (!context)
      return notFound();

    const term = await termFor(card.termId);
    const snapshot = card.snapshot as Record<string, unknown>;

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
      school: { name: context.schoolName, county: context.county },
      student: {
        name: `${context.givenName} ${context.familyName}`,
        admissionNumber: context.admissionNumber,
      },
      term: term ? { number: term.number, year: term.year } : null,
      className: `${context.gradeName} ${context.streamName}`,
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
    const context = await contextFor(certificate.schoolId, certificate.enrollmentId);
    if (!context)
      return notFound();

    const term = await termFor(certificate.termId);
    const snapshot = certificate.snapshot as Record<string, unknown>;

    return c.json({
      documentType: "transition_certificate" as const,
      school: { name: context.schoolName, county: context.county },
      student: {
        name: `${context.givenName} ${context.familyName}`,
        admissionNumber: context.admissionNumber,
      },
      term: term ? { number: term.number, year: term.year } : null,
      className: `${context.gradeName} ${context.streamName}`,
      issuedAt: certificate.issuedAt.toISOString(),
      summary: snapshot,
      status: "valid" as const,
      statusReason: null,
    }, HttpStatusCodes.OK);
  }

  return notFound();
};
