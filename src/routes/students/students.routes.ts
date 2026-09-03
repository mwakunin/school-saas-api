import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";
import { createErrorSchema, IdUUIDParamsSchema } from "stoker/openapi/schemas";

import {
  forbiddenSchema,
  notFoundSchema,
  unauthorizedSchema,
} from "@/lib/constants";
import { requireMembershipRole } from "@/middlewares/auth";

import {
  createEnrollmentSchema,
  createGuardianSchema,
  createStudentSchema,
  exitStudentSchema,
  guardianDetailSchema,
  linkGuardianSchema,
  listStudentsQuerySchema,
  readmitStudentSchema,
  selectGuardianSchema,
  studentDetailSchema,
  studentListItemSchema,
  updateGuardianLinkSchema,
  updateStudentSchema,
} from "./students.schemas";

const tags = ["Students"];

/**
 * Who may see and change a child's record.
 *
 * Teachers read — they need their class list — but do not admit, exit or
 * re-place children; that is an office function. Guardians are deliberately
 * absent from every route here: the parent portal shows a guardian their own
 * children through a separate, narrower surface, not through the register.
 */
const staffRead = requireMembershipRole("admin", "bursar", "teacher");
const officeOnly = requireMembershipRole("admin", "bursar");

const errorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    notFoundSchema,
    "No school at this address, or no such record in it",
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Wrong role, or school suspended"),
};

export const list = createRoute({
  tags,
  method: "get",
  path: "/students",
  summary: "The register",
  description:
    "Active students by default. Searching matches names and admission "
    + "number; filtering by grade level covers every stream in it.",
  middleware: [staffRead],
  request: { query: listStudentsQuerySchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        students: z.array(studentListItemSchema),
        total: z.number().int(),
      }),
      "Students with their current class",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(listStudentsQuerySchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const getOne = createRoute({
  tags,
  method: "get",
  path: "/students/{id}",
  summary: "One child's record",
  middleware: [staffRead],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      studentDetailSchema,
      "The student, their enrollment history and their guardians",
    ),
    ...errorResponses,
  },
});

export const create = createRoute({
  tags,
  method: "post",
  path: "/students",
  summary: "Admit a student",
  middleware: [officeOnly],
  request: { body: jsonContentRequired(createStudentSchema, "The child to admit") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(studentDetailSchema, "The admitted student"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "That admission number or UPI is already used at this school",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createStudentSchema),
      "Validation error, or the stream belongs to another school",
    ),
    ...errorResponses,
  },
});

export const update = createRoute({
  tags,
  method: "patch",
  path: "/students/{id}",
  summary: "Correct a student's details",
  description:
    "Status is deliberately not settable here — leaving the school is a "
    + "transition with consequences, so it has its own route.",
  middleware: [officeOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(updateStudentSchema, "The corrections"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(studentDetailSchema, "The updated student"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "That admission number or UPI is already used at this school",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(updateStudentSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const exitStudent = createRoute({
  tags,
  method: "post",
  path: "/students/{id}/exit",
  summary: "Transfer out, graduate, withdraw or record a death",
  description:
    "Closes the open enrollment and records the exit date. Nothing is "
    + "deleted — the child's marks, invoices and payments stay fully "
    + "queryable, which is what makes a transfer certificate possible later.",
  middleware: [officeOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(exitStudentSchema, "How and when they left"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(studentDetailSchema, "The exited student"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Already exited"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(exitStudentSchema),
      "Validation error, or the exit date precedes admission",
    ),
    ...errorResponses,
  },
});

export const readmit = createRoute({
  tags,
  method: "post",
  path: "/students/{id}/readmit",
  summary: "Undo an exit",
  description:
    "For an exit entered by mistake, and for a child who comes back. The "
    + "previous enrollment stays closed; a new one is opened if a class is "
    + "given.",
  middleware: [officeOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(readmitStudentSchema, "Where to place them"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(studentDetailSchema, "The readmitted student"),
    [HttpStatusCodes.CONFLICT]: jsonContent(notFoundSchema, "Already active"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(readmitStudentSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const enroll = createRoute({
  tags,
  method: "post",
  path: "/students/{id}/enrollments",
  summary: "Place a student in a class, or move them",
  description:
    "Opening a new enrollment closes the current one. A child cannot be in "
    + "two classes on the same day, so the previous enrollment's last day must "
    + "fall before the new one starts.",
  middleware: [officeOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(createEnrollmentSchema, "The placement"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(studentDetailSchema, "The student, re-placed"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "The dates overlap an existing enrollment",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createEnrollmentSchema),
      "Validation error, or the stream belongs to another school",
    ),
    ...errorResponses,
  },
});

// --- Guardians ---

export const listGuardians = createRoute({
  tags,
  method: "get",
  path: "/guardians",
  summary: "Guardians",
  middleware: [staffRead],
  request: {
    query: z.object({
      q: z.string().max(100).optional(),
      /** Finds an existing guardian before creating a duplicate. */
      phone: z.string().max(30).optional(),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(z.array(selectGuardianSchema), "Guardians"),
    ...errorResponses,
  },
});

export const getGuardian = createRoute({
  tags,
  method: "get",
  path: "/guardians/{id}",
  summary: "One guardian and their children",
  middleware: [staffRead],
  request: { params: IdUUIDParamsSchema },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(guardianDetailSchema, "The guardian"),
    ...errorResponses,
  },
});

export const createGuardian = createRoute({
  tags,
  method: "post",
  path: "/guardians",
  summary: "Record a guardian",
  description:
    "Returns 409 with the existing guardian if the phone number is already "
    + "known, so siblings end up sharing one record rather than three.",
  middleware: [officeOnly],
  request: { body: jsonContentRequired(createGuardianSchema, "The guardian") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(selectGuardianSchema, "The new guardian"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      z.object({
        message: z.string(),
        existing: selectGuardianSchema,
      }),
      "A guardian with this phone number already exists here",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(createGuardianSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const linkGuardian = createRoute({
  tags,
  method: "post",
  path: "/students/{id}/guardians",
  summary: "Attach a guardian to a child",
  middleware: [officeOnly],
  request: {
    params: IdUUIDParamsSchema,
    body: jsonContentRequired(linkGuardianSchema, "Existing guardian, or a new one"),
  },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(studentDetailSchema, "The student"),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      notFoundSchema,
      "That guardian is already linked to this child",
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(linkGuardianSchema),
      "Validation error, or the guardian belongs to another school",
    ),
    ...errorResponses,
  },
});

export const updateGuardianLink = createRoute({
  tags,
  method: "patch",
  path: "/students/{studentId}/guardians/{guardianId}",
  summary: "Change what a guardian may do",
  middleware: [officeOnly],
  request: {
    params: z.object({ studentId: z.uuid(), guardianId: z.uuid() }),
    body: jsonContentRequired(updateGuardianLinkSchema, "The changes"),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(studentDetailSchema, "The student"),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createErrorSchema(updateGuardianLinkSchema),
      "Validation error",
    ),
    ...errorResponses,
  },
});

export const unlinkGuardian = createRoute({
  tags,
  method: "delete",
  path: "/students/{studentId}/guardians/{guardianId}",
  summary: "Detach a guardian from a child",
  description:
    "The one thing in this system that is genuinely deleted. A wrongly "
    + "attached adult carries a right to collect a child, and that has to "
    + "disappear from every query rather than linger behind a flag. The "
    + "guardian record itself survives.",
  middleware: [officeOnly],
  request: {
    params: z.object({ studentId: z.uuid(), guardianId: z.uuid() }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(studentDetailSchema, "The student"),
    ...errorResponses,
  },
});

export type ListRoute = typeof list;
export type GetOneRoute = typeof getOne;
export type CreateRoute = typeof create;
export type UpdateRoute = typeof update;
export type ExitRoute = typeof exitStudent;
export type ReadmitRoute = typeof readmit;
export type EnrollRoute = typeof enroll;
export type ListGuardiansRoute = typeof listGuardians;
export type GetGuardianRoute = typeof getGuardian;
export type CreateGuardianRoute = typeof createGuardian;
export type LinkGuardianRoute = typeof linkGuardian;
export type UpdateGuardianLinkRoute = typeof updateGuardianLink;
export type UnlinkGuardianRoute = typeof unlinkGuardian;
