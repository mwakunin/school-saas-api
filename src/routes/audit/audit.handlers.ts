import { and, count, desc, eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";

import type { TenantRouteHandler } from "@/lib/types";

import { auditLog, user } from "@/db/schema";

import type { ListAuditRoute } from "./audit.routes";

export const listAudit: TenantRouteHandler<ListAuditRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.action)
    filters.push(eq(auditLog.action, query.action as never));
  if (query.entityType)
    filters.push(eq(auditLog.entityType, query.entityType));
  if (query.entityId)
    filters.push(eq(auditLog.entityId, query.entityId));
  if (query.actorId)
    filters.push(eq(auditLog.actorId, query.actorId));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [{ total }] = await db
    .select({ total: count() })
    .from(auditLog)
    .where(where);

  /*
   * The actor's name joined in, not just their id.
   *
   * `user` is global rather than tenant-scoped, so this join reaches outside
   * the school — which is safe because the id being resolved is one this
   * school's own log put there. A screen showing `f7bCmzho...` answers nobody's
   * question, and the whole value of this table is that a head can read it.
   */
  const entries = await db
    .select({
      id: auditLog.id,
      schoolId: auditLog.schoolId,
      actorId: auditLog.actorId,
      actorName: user.name,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      summary: auditLog.summary,
      detail: auditLog.detail,
      at: auditLog.at,
    })
    .from(auditLog)
    .leftJoin(user, eq(auditLog.actorId, user.id))
    .where(where)
    /*
     * The id breaks the tie, and it is needed more often than it looks.
     *
     * `at` defaults to `now()`, which inside a transaction is the transaction's
     * start time — so every entry written by one request shares a timestamp
     * exactly. Ordering on `at` alone leaves those rows in whatever order the
     * plan happens to produce, and a reader paging through would see some
     * twice and miss others.
     */
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({ entries, total }, HttpStatusCodes.OK);
};
