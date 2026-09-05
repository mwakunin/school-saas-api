import { z } from "@hono/zod-openapi";

import { toZodV4SchemaTyped } from "@/lib/zod-utils";

/**
 * Who may act at this school, and as what.
 *
 * The tenant-side half of membership management. Until now the only way to
 * grant one was the superadmin plane, so every new bursar needed the platform
 * operator — which is fine for onboarding the first admin and absurd for the
 * rest of a school's life.
 */
export const membershipRole = z.enum(["admin", "bursar", "teacher", "guardian"]);

export const staffMemberSchema = toZodV4SchemaTyped(
  z.object({
    id: z.uuid(),
    userId: z.string(),
    /** Resolved, because an opaque id answers nobody's question. */
    name: z.string().nullable(),
    email: z.string().nullable(),
    role: membershipRole,
    isActive: z.boolean(),
    createdAt: z.string(),
  }),
);

export const grantStaffSchema = toZodV4SchemaTyped(
  z.object({
    /**
     * By email, because that is what a head has in front of them.
     *
     * The account must already exist — this grants access, it does not create
     * people. An invitation flow is real work and is not built; saying so is
     * better than a half one.
     */
    email: z.email(),
    role: membershipRole,
  }),
);

export const updateStaffSchema = toZodV4SchemaTyped(
  z.object({
    /**
     * Revoking sets this false rather than deleting the row.
     *
     * `withMembership` only accepts active memberships, so it takes effect
     * everywhere immediately — and for a product holding children's records,
     * "who used to have access, and when did that stop" is a question worth
     * being able to answer.
     */
    isActive: z.boolean(),
  }),
);

export const listStaffQuerySchema = z.object({
  role: membershipRole.optional(),
  /** Off by default: the staff screen is about who can act today. */
  includeInactive: z.stringbool().default(false),
});
