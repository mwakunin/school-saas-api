import { z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";

import {
  enrollments,
  gradeLevels,
  guardians,
  streams,
  students,
} from "@/db/schema";
import { normalizeKenyanPhone } from "@/lib/phone";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";

const rawSelectStudent = createSelectSchema(students);
const rawSelectEnrollment = createSelectSchema(enrollments);
const rawSelectGuardian = createSelectSchema(guardians);
const rawSelectStream = createSelectSchema(streams);
const rawSelectGradeLevel = createSelectSchema(gradeLevels);

/**
 * A Kenyan mobile number, stored E.164 (CLAUDE.md §3 rule 10).
 *
 * Normalised here rather than at the point of sending, because the same number
 * arrives as `0712345678`, `+254712345678`, `254712345678` and `712345678`,
 * and a guardian recorded three different ways is three fee reminders to one
 * parent and three phone numbers nobody can reconcile.
 */
const kenyanPhone = z.string().transform((value, ctx) => {
  const normalized = normalizeKenyanPhone(value);
  if (!normalized) {
    ctx.addIssue({
      code: "custom",
      message: "Not a valid Kenyan mobile number",
    });
    return z.NEVER;
  }
  return normalized;
});

const optionalKenyanPhone = z.string().optional().transform((value, ctx) => {
  if (value === undefined || value === "")
    return undefined;
  const normalized = normalizeKenyanPhone(value);
  if (!normalized) {
    ctx.addIssue({
      code: "custom",
      message: "Not a valid Kenyan mobile number",
    });
    return z.NEVER;
  }
  return normalized;
});

/** A calendar day that is not in the future — a birthday, an admission date. */
const pastDate = z.iso.date().refine(
  value => value <= new Date().toISOString().slice(0, 10),
  "Cannot be in the future",
);

export const selectStudentSchema = toZodV4SchemaTyped(rawSelectStudent);

/** The current class, resolved from the open enrollment rather than a column. */
const currentEnrollmentShape = rawSelectEnrollment.pick({
  id: true,
  streamId: true,
  boardingStatus: true,
  startedOn: true,
}).extend({
  stream: rawSelectStream.pick({ id: true, name: true }).extend({
    gradeLevel: rawSelectGradeLevel.pick({
      id: true,
      name: true,
      sequence: true,
      phase: true,
    }),
  }),
});

export const studentListItemSchema = toZodV4SchemaTyped(
  rawSelectStudent.extend({
    // Null for a student with no open enrollment — newly admitted but not yet
    // placed, or already exited. Both are real states, so this is nullable
    // rather than an error.
    currentEnrollment: currentEnrollmentShape.nullable(),
  }),
);

export const guardianLinkSchema = rawSelectGuardian.extend({
  relationship: z.string().nullable(),
  isPrimary: z.boolean(),
  receivesInvoices: z.boolean(),
  canCollect: z.boolean(),
});

export const studentDetailSchema = toZodV4SchemaTyped(
  rawSelectStudent.extend({
    currentEnrollment: currentEnrollmentShape.nullable(),
    // Full history, not just the current row: "which class was this child in
    // when they sat that exam" is the question enrollment exists to answer.
    enrollments: z.array(rawSelectEnrollment.extend({
      stream: rawSelectStream.pick({ id: true, name: true }).extend({
        gradeLevel: rawSelectGradeLevel.pick({ id: true, name: true, sequence: true }),
      }),
    })),
    guardians: z.array(guardianLinkSchema),
  }),
);

export const createStudentSchema = toZodV4SchemaTyped(
  z.object({
    admissionNumber: z.string().min(1).max(50),
    givenName: z.string().min(1).max(100),
    middleNames: z.string().max(200).optional(),
    familyName: z.string().min(1).max(100),
    preferredName: z.string().max(100).optional(),

    upiNumber: z.string().max(50).optional(),
    birthCertNumber: z.string().max(50).optional(),
    dateOfBirth: pastDate.optional(),
    sex: z.enum(["male", "female"]).optional(),
    previousSchool: z.string().max(200).optional(),

    admittedOn: pastDate,

    /**
     * Placing the child in a class at admission.
     *
     * Optional because a school may admit before deciding the stream, but
     * offered here because doing it in one step is what an admissions clerk
     * actually wants — and because a student with no enrollment appears in no
     * class list and gets no invoice.
     */
    enrollment: z.object({
      streamId: z.uuid(),
      boardingStatus: z.enum(["day", "boarder"]),
      startedOn: z.iso.date().optional(),
    }).optional(),
  }),
);

export const updateStudentSchema = toZodV4SchemaTyped(
  z.object({
    admissionNumber: z.string().min(1).max(50).optional(),
    givenName: z.string().min(1).max(100).optional(),
    middleNames: z.string().max(200).nullable().optional(),
    familyName: z.string().min(1).max(100).optional(),
    preferredName: z.string().max(100).nullable().optional(),
    upiNumber: z.string().max(50).nullable().optional(),
    birthCertNumber: z.string().max(50).nullable().optional(),
    dateOfBirth: pastDate.nullable().optional(),
    sex: z.enum(["male", "female"]).nullable().optional(),
    photoUrl: z.url().nullable().optional(),
    previousSchool: z.string().max(200).nullable().optional(),
  }).refine(
    v => Object.keys(v).length > 0,
    { message: "No updates provided" },
  ),
);

/**
 * Exiting a child from the register.
 *
 * `status` cannot be set through the ordinary update route: leaving is a
 * transition with consequences — the open enrollment closes, an exit date is
 * recorded — and letting it be patched like a name would produce students who
 * are `withdrawn` while still appearing on every class list.
 */
export const exitStudentSchema = toZodV4SchemaTyped(
  z.object({
    status: z.enum(["transferred_out", "graduated", "withdrawn", "deceased"]),
    exitedOn: pastDate,
    /*
     * Deliberately no `note` field.
     *
     * Recording where a transfer went is genuinely useful — `previousSchool`
     * covers the inbound direction and there is no outbound equivalent — but
     * there is no column for it yet. Accepting the text and discarding it
     * would be worse than not offering it: the office would believe the
     * destination was recorded, and discover otherwise when asked for a
     * transfer certificate. Add the column, then add the field.
     */
  }),
);

/** Undoing an exit entered by mistake. */
export const readmitStudentSchema = toZodV4SchemaTyped(
  z.object({
    enrollment: z.object({
      streamId: z.uuid(),
      boardingStatus: z.enum(["day", "boarder"]),
      startedOn: z.iso.date(),
    }).optional(),
  }),
);

/**
 * Left unwrapped, unlike the body schemas.
 *
 * `request.query` needs a real ZodObject so @hono/zod-openapi can enumerate
 * the parameters; `toZodV4SchemaTyped` erases that to a bare ZodType and the
 * route stops typechecking. Query schemas therefore never go through the
 * wrapper — they are hand-written zod anyway, so there is nothing to bridge.
 */
export const listStudentsQuerySchema = (
  z.object({
    /** Matches family, given or preferred name, and admission number. */
    q: z.string().max(100).optional(),
    streamId: z.uuid().optional(),
    gradeLevelId: z.uuid().optional(),
    status: z.enum([
      "active",
      "transferred_out",
      "graduated",
      "withdrawn",
      "deceased",
    ]).optional(),
    /**
     * Defaults to active only. A class list that silently included last year's
     * withdrawn pupils is the kind of error nobody notices until an invoice run
     * bills them.
     */
    includeExited: z.stringbool().default(false),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
);

export const createEnrollmentSchema = toZodV4SchemaTyped(
  z.object({
    streamId: z.uuid(),
    boardingStatus: z.enum(["day", "boarder"]),
    startedOn: z.iso.date(),
    /**
     * The day the previous enrollment ended.
     *
     * Required when the child already has an open one, because the overlap
     * constraint refuses two enrollments covering the same day and a caller
     * who omitted this would get a bare 409 with nothing to act on.
     */
    previousEndedOn: z.iso.date().optional(),
  }),
);

export const selectGuardianSchema = toZodV4SchemaTyped(rawSelectGuardian);

export const createGuardianSchema = toZodV4SchemaTyped(
  z.object({
    name: z.string().min(1).max(200),
    phone: kenyanPhone,
    altPhone: optionalKenyanPhone,
    email: z.email().optional(),
    nationalId: z.string().max(50).optional(),
    occupation: z.string().max(100).optional(),
  }),
);

export const linkGuardianSchema = toZodV4SchemaTyped(
  z.object({
    /** Link an existing guardian — the sibling case. */
    guardianId: z.uuid().optional(),
    /** Or create one and link it in the same request. */
    guardian: z.object({
      name: z.string().min(1).max(200),
      phone: kenyanPhone,
      altPhone: optionalKenyanPhone,
      email: z.email().optional(),
      nationalId: z.string().max(50).optional(),
      occupation: z.string().max(100).optional(),
    }).optional(),

    relationship: z.string().max(50).optional(),
    isPrimary: z.boolean().default(false),
    receivesInvoices: z.boolean().default(true),
    canCollect: z.boolean().default(true),
  }).refine(
    v => Boolean(v.guardianId) !== Boolean(v.guardian),
    { message: "Provide exactly one of guardianId or guardian" },
  ),
);

export const updateGuardianLinkSchema = toZodV4SchemaTyped(
  z.object({
    relationship: z.string().max(50).nullable().optional(),
    isPrimary: z.boolean().optional(),
    receivesInvoices: z.boolean().optional(),
    canCollect: z.boolean().optional(),
  }).refine(
    v => Object.keys(v).length > 0,
    { message: "No updates provided" },
  ),
);

/** A guardian with the children they are responsible for. */
export const guardianDetailSchema = toZodV4SchemaTyped(
  rawSelectGuardian.extend({
    students: z.array(rawSelectStudent.pick({
      id: true,
      admissionNumber: true,
      givenName: true,
      familyName: true,
      status: true,
    }).extend({
      relationship: z.string().nullable(),
      isPrimary: z.boolean(),
      receivesInvoices: z.boolean(),
      canCollect: z.boolean(),
    })),
  }),
);
