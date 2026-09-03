import { and, asc, count, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { AppDb } from "@/db";
import type { TenantRouteHandler } from "@/lib/types";

import {
  enrollments,
  gradeLevels,
  guardians,
  streams,
  studentGuardians,
  students,
} from "@/db/schema";
import {
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
} from "@/lib/db-errors";

import type {
  CreateGuardianRoute,
  CreateRoute,
  EnrollRoute,
  ExitRoute,
  GetGuardianRoute,
  GetOneRoute,
  LinkGuardianRoute,
  ListGuardiansRoute,
  ListRoute,
  ReadmitRoute,
  UnlinkGuardianRoute,
  UpdateGuardianLinkRoute,
  UpdateRoute,
} from "./students.routes";

/**
 * No query here carries a `where school_id = ...`. The RLS policies apply it
 * inside Postgres — see middlewares/tenant.ts and migration 0002.
 */

/**
 * The detail payload for a student that must exist.
 *
 * Used after a write that just created or updated the row inside the same
 * transaction. A null here is not a missing record — it is an invariant
 * violation, so it throws rather than being folded into a 404 that would
 * misreport what went wrong.
 */
async function requireStudentDetail(db: AppDb, studentId: string) {
  const detail = await studentDetail(db, studentId);
  if (!detail)
    throw new Error(`Student ${studentId} vanished mid-request`);
  return detail;
}

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

/**
 * The whole record for one child.
 *
 * Assembled in one place because admission, exit, re-placement and every
 * guardian change all return it — a caller that had to re-fetch after each
 * mutation would show a stale class on the screen it just submitted from.
 */
async function studentDetail(db: AppDb, studentId: string) {
  const [student] = await db
    .select()
    .from(students)
    .where(eq(students.id, studentId));

  if (!student)
    return null;

  // Selected flat and reshaped below: drizzle types a two-level nested
  // selection as an index signature, which erases every field. One level is
  // the supported depth, so the nesting happens here instead.
  const historyRows = await db
    .select({
      id: enrollments.id,
      schoolId: enrollments.schoolId,
      studentId: enrollments.studentId,
      streamId: enrollments.streamId,
      boardingStatus: enrollments.boardingStatus,
      startedOn: enrollments.startedOn,
      endedOn: enrollments.endedOn,
      streamName: streams.name,
      gradeLevelId: gradeLevels.id,
      gradeLevelName: gradeLevels.name,
      gradeLevelSequence: gradeLevels.sequence,
      gradeLevelPhase: gradeLevels.phase,
    })
    .from(enrollments)
    .innerJoin(streams, eq(enrollments.streamId, streams.id))
    .innerJoin(gradeLevels, eq(streams.gradeLevelId, gradeLevels.id))
    .where(eq(enrollments.studentId, studentId))
    .orderBy(desc(enrollments.startedOn));

  const history = historyRows.map(r => ({
    id: r.id,
    schoolId: r.schoolId,
    studentId: r.studentId,
    streamId: r.streamId,
    boardingStatus: r.boardingStatus,
    startedOn: r.startedOn,
    endedOn: r.endedOn,
    stream: {
      id: r.streamId,
      name: r.streamName,
      gradeLevel: {
        id: r.gradeLevelId,
        name: r.gradeLevelName,
        sequence: r.gradeLevelSequence,
        phase: r.gradeLevelPhase,
      },
    },
  }));

  const linked = await db
    .select({
      id: guardians.id,
      schoolId: guardians.schoolId,
      userId: guardians.userId,
      name: guardians.name,
      phone: guardians.phone,
      altPhone: guardians.altPhone,
      email: guardians.email,
      nationalId: guardians.nationalId,
      occupation: guardians.occupation,
      relationship: studentGuardians.relationship,
      isPrimary: studentGuardians.isPrimary,
      receivesInvoices: studentGuardians.receivesInvoices,
      canCollect: studentGuardians.canCollect,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(studentGuardians.guardianId, guardians.id))
    .where(eq(studentGuardians.studentId, studentId))
    // Primary contact first: it is who the office rings.
    .orderBy(desc(studentGuardians.isPrimary), asc(guardians.name));

  // "Which class is this child in" is the open enrollment row, not a column on
  // the student — which is what keeps last year's marks pointing at last
  // year's class after progression.
  const current = history.find(e => e.endedOn === null) ?? null;

  return {
    ...student,
    currentEnrollment: current
      ? {
          id: current.id,
          streamId: current.streamId,
          boardingStatus: current.boardingStatus,
          startedOn: current.startedOn,
          stream: current.stream,
        }
      : null,
    enrollments: history,
    guardians: linked,
  };
}

export const list: TenantRouteHandler<ListRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];

  if (!query.includeExited && !query.status)
    filters.push(eq(students.status, "active"));

  if (query.status)
    filters.push(eq(students.status, query.status));

  if (query.q) {
    // Matching the admission number as well as the names, because half the
    // time the office is reading a number off a fee slip rather than a name.
    const term = `%${query.q}%`;
    filters.push(or(
      ilike(students.familyName, term),
      ilike(students.givenName, term),
      ilike(students.preferredName, term),
      ilike(students.admissionNumber, term),
    )!);
  }

  /*
   * Filtering by class means filtering by OPEN enrollment.
   *
   * A student who left Grade 4 Blue in March is not in Grade 4 Blue now, and a
   * class list that included them would be wrong in the two places it matters
   * most: the register a teacher marks, and the invoice run.
   */
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

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [{ total }] = await db
    .select({ total: count() })
    .from(students)
    .where(where);

  const rows = await db
    .select({ id: students.id })
    .from(students)
    .where(where)
    // Family name first: it is how a Kenyan register is read and how the
    // office looks someone up.
    .orderBy(asc(students.familyName), asc(students.givenName))
    .limit(query.limit)
    .offset(query.offset);

  const detailed = await Promise.all(
    rows.map(r => studentDetail(db, r.id)),
  );

  const list = detailed
    .filter(s => s !== null)
    .map(({ enrollments: _history, guardians: _linked, ...rest }) => rest);

  return c.json({ students: list, total }, HttpStatusCodes.OK);
};

export const getOne: TenantRouteHandler<GetOneRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const student = await studentDetail(c.var.db, id);

  if (!student) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(student, HttpStatusCodes.OK);
};

export const create: TenantRouteHandler<CreateRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;
  const schoolId = c.var.school.id;

  try {
    const id = await db.transaction(async (tx) => {
      const [student] = await tx
        .insert(students)
        .values({
          schoolId,
          admissionNumber: body.admissionNumber,
          givenName: body.givenName,
          middleNames: body.middleNames,
          familyName: body.familyName,
          preferredName: body.preferredName,
          upiNumber: body.upiNumber,
          birthCertNumber: body.birthCertNumber,
          dateOfBirth: body.dateOfBirth,
          sex: body.sex,
          previousSchool: body.previousSchool,
          admittedOn: body.admittedOn,
          status: "active",
        })
        .returning();

      if (body.enrollment) {
        await tx.insert(enrollments).values({
          schoolId,
          studentId: student.id,
          streamId: body.enrollment.streamId,
          boardingStatus: body.enrollment.boardingStatus,
          // Defaults to the admission date, which is what it is in practice.
          startedOn: body.enrollment.startedOn ?? body.admittedOn,
        });
      }

      return student.id;
    });

    return c.json(await requireStudentDetail(db, id), HttpStatusCodes.CREATED);
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That admission number or UPI is already used at this school" },
        HttpStatusCodes.CONFLICT,
      );
    }
    // A stream at another school is invisible under RLS, so the composite
    // foreign key finds nothing. Reported against the field rather than as a
    // 403: from here that id simply does not exist.
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["enrollment", "streamId"], "No such class at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }
};

export const update: TenantRouteHandler<UpdateRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  try {
    const [updated] = await c.var.db
      .update(students)
      .set(body)
      .where(eq(students.id, id))
      .returning({ id: students.id });

    if (!updated) {
      return c.json(
        { message: HttpStatusPhrases.NOT_FOUND },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    return c.json(await requireStudentDetail(c.var.db, id), HttpStatusCodes.OK);
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That admission number or UPI is already used at this school" },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const exitStudent: TenantRouteHandler<ExitRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  const [existing] = await db
    .select({ status: students.status, admittedOn: students.admittedOn })
    .from(students)
    .where(eq(students.id, id));

  if (!existing) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (existing.status !== "active") {
    return c.json(
      { message: "This student has already left" },
      HttpStatusCodes.CONFLICT,
    );
  }

  if (body.exitedOn < existing.admittedOn) {
    return c.json(
      fieldError(["exitedOn"], "Cannot leave before being admitted"),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  await db.transaction(async (tx) => {
    /*
     * Close the open enrollment as well as marking the student.
     *
     * Leaving it open is what produces a withdrawn child who still appears on
     * a class list and still gets invoiced — the failure this whole shape
     * exists to prevent. Nothing is deleted: the enrollment, its marks and its
     * invoices all stay queryable, which is what makes a transfer certificate
     * possible two years from now.
     */
    await tx
      .update(enrollments)
      .set({ endedOn: body.exitedOn })
      .where(and(
        eq(enrollments.studentId, id),
        isNull(enrollments.endedOn),
      ));

    await tx
      .update(students)
      // The CHECK constraint ties status and exit date together, so they move
      // as a pair or the transaction fails.
      .set({ status: body.status, exitedOn: body.exitedOn })
      .where(eq(students.id, id));
  });

  return c.json(await requireStudentDetail(db, id), HttpStatusCodes.OK);
};

export const readmit: TenantRouteHandler<ReadmitRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  const [existing] = await db
    .select({ status: students.status })
    .from(students)
    .where(eq(students.id, id));

  if (!existing) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  if (existing.status === "active") {
    return c.json(
      { message: "This student is already active" },
      HttpStatusCodes.CONFLICT,
    );
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(students)
        // The CHECK constraint ties these two together, so they move as a pair.
        .set({ status: "active", exitedOn: null })
        .where(eq(students.id, id));

      if (body.enrollment) {
        await tx.insert(enrollments).values({
          schoolId: c.var.school.id,
          studentId: id,
          streamId: body.enrollment.streamId,
          boardingStatus: body.enrollment.boardingStatus,
          startedOn: body.enrollment.startedOn,
        });
      }
    });
  }
  catch (err) {
    if (isExclusionViolation(err)) {
      return c.json(
        fieldError(
          ["enrollment", "startedOn"],
          "Overlaps an earlier enrollment — a child cannot be in two classes at once",
        ),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["enrollment", "streamId"], "No such class at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }

  return c.json(await requireStudentDetail(db, id), HttpStatusCodes.OK);
};

export const enroll: TenantRouteHandler<EnrollRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  const [student] = await db
    .select({ status: students.status })
    .from(students)
    .where(eq(students.id, id));

  if (!student) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  try {
    await db.transaction(async (tx) => {
      const [open] = await tx
        .select({ id: enrollments.id, startedOn: enrollments.startedOn })
        .from(enrollments)
        .where(and(
          eq(enrollments.studentId, id),
          isNull(enrollments.endedOn),
        ));

      if (open) {
        /*
         * Close the previous placement before opening the new one.
         *
         * Default the last day to the day before the move, so a straightforward
         * "she starts in East on Monday" needs no arithmetic from the caller.
         * The overlap constraint is what actually guarantees correctness — this
         * just makes the common case not trip it.
         */
        const endedOn = body.previousEndedOn
          ?? new Date(new Date(body.startedOn).getTime() - 86_400_000)
            .toISOString()
            .slice(0, 10);

        await tx
          .update(enrollments)
          .set({ endedOn })
          .where(eq(enrollments.id, open.id));
      }

      await tx.insert(enrollments).values({
        schoolId: c.var.school.id,
        studentId: id,
        streamId: body.streamId,
        boardingStatus: body.boardingStatus,
        startedOn: body.startedOn,
      });
    });
  }
  catch (err) {
    if (isExclusionViolation(err)) {
      return c.json(
        {
          message:
            "These dates overlap an existing enrollment — a child cannot be "
            + "in two classes on the same day",
        },
        HttpStatusCodes.CONFLICT,
      );
    }
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["streamId"], "No such class at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    /*
     * `enrollments_dates_ordered`.
     *
     * Reached by moving a child to a date at or before the day their current
     * placement began: the previous enrollment's computed end date then falls
     * before its own start. That is a mistake in the request, not a server
     * fault, so it must not surface as a 500 — the clerk needs to be told
     * which date is wrong.
     */
    if (isCheckViolation(err)) {
      return c.json(
        fieldError(
          ["startedOn"],
          "Cannot start before the current placement began",
        ),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }

  return c.json(await requireStudentDetail(db, id), HttpStatusCodes.CREATED);
};

// ---------------------------------------------------------------------------
// Guardians
// ---------------------------------------------------------------------------

export const listGuardians: TenantRouteHandler<ListGuardiansRoute> = async (c) => {
  const { q, phone } = c.req.valid("query");
  const db = c.var.db;
  const filters = [];

  if (q)
    filters.push(ilike(guardians.name, `%${q}%`));

  if (phone) {
    // Matched on the tail rather than exactly: the caller may have `0712...`
    // while the row holds `+254712...`, and normalising here would reject a
    // partial number that is still a useful search.
    const digits = phone.replace(/\D/g, "").slice(-9);
    if (digits)
      filters.push(ilike(guardians.phone, `%${digits}`));
  }

  const rows = await db
    .select()
    .from(guardians)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(guardians.name))
    .limit(100);

  return c.json(rows, HttpStatusCodes.OK);
};

export const getGuardian: TenantRouteHandler<GetGuardianRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const db = c.var.db;

  const [guardian] = await db
    .select()
    .from(guardians)
    .where(eq(guardians.id, id));

  if (!guardian) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  // The sibling view: one parent, all their children. This is what makes a
  // single fee reminder possible instead of one per child.
  const children = await db
    .select({
      id: students.id,
      admissionNumber: students.admissionNumber,
      givenName: students.givenName,
      familyName: students.familyName,
      status: students.status,
      relationship: studentGuardians.relationship,
      isPrimary: studentGuardians.isPrimary,
      receivesInvoices: studentGuardians.receivesInvoices,
      canCollect: studentGuardians.canCollect,
    })
    .from(studentGuardians)
    .innerJoin(students, eq(studentGuardians.studentId, students.id))
    .where(eq(studentGuardians.guardianId, id))
    .orderBy(asc(students.familyName), asc(students.givenName));

  return c.json({ ...guardian, students: children }, HttpStatusCodes.OK);
};

export const createGuardian: TenantRouteHandler<CreateGuardianRoute> = async (c) => {
  const body = c.req.valid("json");
  const db = c.var.db;

  // Deduplication is the whole reason guardians are a table rather than
  // columns on the student. Offered as a 409 carrying the existing record so
  // the caller can link to it, rather than silently reusing a row that might
  // be a different person on a shared household handset.
  const [existing] = await db
    .select()
    .from(guardians)
    .where(eq(guardians.phone, body.phone));

  if (existing) {
    return c.json(
      {
        message: "A guardian with this phone number already exists at this school",
        existing,
      },
      HttpStatusCodes.CONFLICT,
    );
  }

  const [created] = await db
    .insert(guardians)
    .values({ ...body, schoolId: c.var.school.id })
    .returning();

  return c.json(created, HttpStatusCodes.CREATED);
};

export const linkGuardian: TenantRouteHandler<LinkGuardianRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;
  const schoolId = c.var.school.id;

  const [student] = await db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.id, id));

  if (!student) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  try {
    await db.transaction(async (tx) => {
      let guardianId = body.guardianId;

      if (!guardianId && body.guardian) {
        const [created] = await tx
          .insert(guardians)
          .values({ ...body.guardian, schoolId })
          .returning({ id: guardians.id });
        guardianId = created.id;
      }

      if (body.isPrimary) {
        // At most one primary contact per child: it answers "who do we ring",
        // and two answers is the same as none.
        await tx
          .update(studentGuardians)
          .set({ isPrimary: false })
          .where(eq(studentGuardians.studentId, id));
      }

      await tx.insert(studentGuardians).values({
        schoolId,
        studentId: id,
        guardianId: guardianId!,
        relationship: body.relationship,
        isPrimary: body.isPrimary,
        receivesInvoices: body.receivesInvoices,
        canCollect: body.canCollect,
      });
    });
  }
  catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { message: "That guardian is already linked to this child" },
        HttpStatusCodes.CONFLICT,
      );
    }
    if (isForeignKeyViolation(err)) {
      return c.json(
        fieldError(["guardianId"], "No such guardian at this school"),
        HttpStatusCodes.UNPROCESSABLE_ENTITY,
      );
    }
    throw err;
  }

  return c.json(await requireStudentDetail(db, id), HttpStatusCodes.CREATED);
};

export const updateGuardianLink: TenantRouteHandler<UpdateGuardianLinkRoute> = async (c) => {
  const { studentId, guardianId } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.var.db;

  const updated = await db.transaction(async (tx) => {
    if (body.isPrimary) {
      await tx
        .update(studentGuardians)
        .set({ isPrimary: false })
        .where(eq(studentGuardians.studentId, studentId));
    }

    const [row] = await tx
      .update(studentGuardians)
      .set(body)
      .where(and(
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.guardianId, guardianId),
      ))
      .returning({ studentId: studentGuardians.studentId });

    return row;
  });

  if (!updated) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(await requireStudentDetail(db, studentId), HttpStatusCodes.OK);
};

export const unlinkGuardian: TenantRouteHandler<UnlinkGuardianRoute> = async (c) => {
  const { studentId, guardianId } = c.req.valid("param");
  const db = c.var.db;

  const [removed] = await db
    .delete(studentGuardians)
    .where(and(
      eq(studentGuardians.studentId, studentId),
      eq(studentGuardians.guardianId, guardianId),
    ))
    .returning({ studentId: studentGuardians.studentId });

  if (!removed) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(await requireStudentDetail(db, studentId), HttpStatusCodes.OK);
};
