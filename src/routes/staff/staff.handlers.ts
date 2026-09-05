import { and, asc, eq, ne } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import type { TenantRouteHandler } from "@/lib/types";

import { memberships, user } from "@/db/schema";
import { recordAudit } from "@/lib/audit";

import type { GrantStaffRoute, ListStaffRoute, UpdateStaffRoute } from "./staff.routes";

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
 * The membership with the person's name and address attached.
 *
 * `user` is global rather than tenant-scoped, so this join reaches outside the
 * school — safe because the id being resolved is one this school's own
 * membership put there, and necessary because a staff screen listing opaque
 * ids is a staff screen nobody can use.
 */
function selectStaff() {
  return {
    id: memberships.id,
    userId: memberships.userId,
    name: user.name,
    email: user.email,
    role: memberships.role,
    isActive: memberships.isActive,
    createdAt: memberships.createdAt,
  };
}

export const listStaff: TenantRouteHandler<ListStaffRoute> = async (c) => {
  const query = c.req.valid("query");
  const db = c.var.db;

  const filters = [];
  if (query.role)
    filters.push(eq(memberships.role, query.role));
  if (!query.includeInactive)
    filters.push(eq(memberships.isActive, true));

  const rows = await db
    .select(selectStaff())
    .from(memberships)
    .innerJoin(user, eq(memberships.userId, user.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(user.name), asc(memberships.role));

  return c.json(
    rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
    HttpStatusCodes.OK,
  );
};

export const grantStaff: TenantRouteHandler<GrantStaffRoute> = async (c) => {
  const { email, role } = c.req.valid("json");
  const db = c.var.db;

  /*
   * The user lookup runs against the global identity table, which RLS does not
   * scope — deliberately, because a person exists once across every school.
   * What keeps this from being a way to read other tenants is that nothing
   * about the user is returned unless a membership is created here.
   */
  const [person] = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.email, email));

  if (!person) {
    return c.json(
      fieldError(
        ["email"],
        "Nobody has signed up with that address yet. Ask them to create an "
        + "account first, then grant it here.",
      ),
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  /*
   * Idempotent, and reactivating rather than returning a dead row.
   *
   * `withMembership` only accepts active memberships, so handing back a
   * deactivated one would answer 201 with access that does not work — the
   * endpoint reporting success while the person still cannot sign in.
   */
  const [granted] = await db
    .insert(memberships)
    .values({ userId: person.id, schoolId: c.var.school.id, role })
    .onConflictDoUpdate({
      target: [memberships.userId, memberships.schoolId, memberships.role],
      set: { isActive: true },
    })
    .returning();

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: "membership.granted",
    entityType: "membership",
    entityId: granted.id,
    summary: `Gave ${person.email ?? person.name} the ${role} role`,
    detail: { role, userId: person.id },
  });

  return c.json({
    id: granted.id,
    userId: granted.userId,
    name: person.name,
    email: person.email,
    role: granted.role,
    isActive: granted.isActive,
    createdAt: granted.createdAt.toISOString(),
  }, HttpStatusCodes.CREATED);
};

export const updateStaff: TenantRouteHandler<UpdateStaffRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const { isActive } = c.req.valid("json");
  const db = c.var.db;

  const [existing] = await db
    .select({ id: memberships.id, role: memberships.role, userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.id, id));

  if (!existing) {
    return c.json(
      { message: HttpStatusPhrases.NOT_FOUND },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  /*
   * A school must not be able to lock itself out.
   *
   * Removing the last admin would leave nobody who can grant one back, and the
   * only remedy would be the platform operator — the exact dependency these
   * routes exist to remove. Counted inside the request transaction, so a
   * concurrent revocation of the other admin cannot slip past between the
   * check and the write.
   */
  if (!isActive && existing.role === "admin") {
    const others = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(
        eq(memberships.role, "admin"),
        eq(memberships.isActive, true),
        ne(memberships.id, id),
      ))
      .for("update");

    if (others.length === 0) {
      return c.json(
        {
          message:
            "This is the school's last admin. Give someone else the admin role "
            + "before removing this one.",
        },
        HttpStatusCodes.CONFLICT,
      );
    }
  }

  const [updated] = await db
    .update(memberships)
    .set({ isActive })
    .where(eq(memberships.id, id))
    .returning();

  const [person] = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, updated.userId));

  await recordAudit(db, {
    schoolId: c.var.school.id,
    actorId: c.var.user!.id,
    action: isActive ? "membership.granted" : "membership.revoked",
    entityType: "membership",
    entityId: updated.id,
    summary: isActive
      ? `Restored ${person?.email ?? updated.userId}'s ${updated.role} access`
      : `Revoked ${person?.email ?? updated.userId}'s ${updated.role} access`,
    detail: { role: updated.role, userId: updated.userId },
  });

  return c.json({
    id: updated.id,
    userId: updated.userId,
    name: person?.name ?? null,
    email: person?.email ?? null,
    role: updated.role,
    isActive: updated.isActive,
    createdAt: updated.createdAt.toISOString(),
  }, HttpStatusCodes.OK);
};
