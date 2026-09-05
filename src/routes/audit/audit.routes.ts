import { createRoute, z } from "@hono/zod-openapi";
import { createSelectSchema } from "drizzle-zod";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent } from "stoker/openapi/helpers";

import { auditLog } from "@/db/schema";
import { forbiddenSchema, notFoundSchema, unauthorizedSchema } from "@/lib/constants";
import { toZodV4SchemaTyped } from "@/lib/zod-utils";
import { requireMembershipRole } from "@/middlewares/auth";

/**
 * The trail, readable by the head and nobody else.
 *
 * Admin-only on purpose. It records who changed a mark and who reversed a
 * payment, so the people it is a check ON must not be the people who can read
 * it looking for what was noticed — a teacher browsing which of their own
 * corrections were logged is not the audience this exists for.
 *
 * There is deliberately no write endpoint. Entries are written by the handlers
 * that perform the actions, inside their transactions, and the runtime role
 * holds no UPDATE or DELETE on the table at all.
 */
const tags = ["Audit"];
const adminOnly = requireMembershipRole("admin");

export const listAudit = createRoute({
  tags,
  method: "get",
  path: "/audit-log",
  summary: "Who did what",
  description:
    "Newest first. Filter by action, by the kind of thing acted on, or by one "
    + "record's id to get its whole history — 'what has happened to this "
    + "payment' being the question that gets asked in anger.",
  middleware: [adminOnly],
  request: {
    query: z.object({
      action: z.string().max(60).optional(),
      entityType: z.string().max(60).optional(),
      entityId: z.uuid().optional(),
      actorId: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      toZodV4SchemaTyped(z.object({
        entries: z.array(createSelectSchema(auditLog).extend({
          /** Who did it, resolved — an opaque id answers nobody's question. */
          actorName: z.string().nullable(),
        })),
        total: z.number().int(),
      })),
      "Audit entries, newest first",
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(unauthorizedSchema, "Not signed in"),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(forbiddenSchema, "Not an admin here"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(notFoundSchema, "No school at this address"),
  },
});

export type ListAuditRoute = typeof listAudit;
