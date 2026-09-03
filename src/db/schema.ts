import { relations, sql } from "drizzle-orm";
import { check, timestamp } from "drizzle-orm/pg-core";

import { account, session, user, verification } from "./auth-schema";

// Re-exported so the rest of the app can `import { user } from "./schema"`
// alongside everything else, without caring that identity tables live in a
// separate Better-Auth-generated file.
export { account, session, user, verification };

// ---------------------------------------------------------------------------
// Shared column builders
//
// The domain tables land in step 2 (tenancy + academic spine). These are kept
// here rather than added alongside them because the rules they encode —
// timestamptz for instants, whole shillings for money — are decisions from
// CLAUDE.md §3, not incidental to whichever table happens to be written first.
// ---------------------------------------------------------------------------

// `.$onUpdate` is what actually makes updated_at move — `.defaultNow()` alone
// freezes it at insert time.
export function updatedAt() {
  return timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

export function createdAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

/**
 * Money is stored as integer cents (CLAUDE.md §3 rule 3). M-Pesa only
 * transacts whole shillings, so every amount must be divisible by 100 —
 * enforced in the database so a seed script, migration or manual SQL can't
 * sneak a bad row past the Zod layer.
 *
 * Not applied to `invoice_lines.amount_cents`, which is deliberately allowed
 * to go negative: a bursary or discount is a negative line (CLAUDE.md §5.7).
 * That column takes the divisibility half of this check without the `>= 0`.
 */
export function wholeShillings(name: string, column: unknown) {
  return check(name, sql`${column} % 100 = 0 AND ${column} >= 0`);
}

/** Divisible by 100, but may be negative — for discount and bursary lines. */
export function wholeShillingsSigned(name: string, column: unknown) {
  return check(name, sql`${column} % 100 = 0`);
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

// ALL relations for `user` live here, including the auth-side ones (sessions,
// accounts) that the Better Auth CLI would otherwise emit into auth-schema.ts.
// Drizzle allows only one `relations()` config per table, and db/index.ts
// spreads both modules into a single schema object — so a second definition
// over there would silently clobber this one rather than erroring.
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));
