import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Owned by Better Auth. Regenerate with:
//
//   npx @better-auth/cli@latest generate --config src/lib/auth.ts \
//     --output src/db/auth-schema.ts --yes
//
// NOTE: the standalone CLI is pinned at 1.4.x while the runtime is 1.7.x, so
// its output is missing things 1.7 requires. Regenerating is a starting point,
// not a finished file.
//
// Five deliberate deviations — reapply every one after regenerating:
//
//  1. `user.role` has `.notNull()` added. The CLI emits a nullable column,
//     which would force a null-check at every authorization site. The DB
//     default ("user") makes notNull safe.
//  2. The CLI also emits `userRelations` / `sessionRelations` /
//     `accountRelations` at the bottom of the file. They are deleted here and
//     redefined in schema.ts instead — a second `relations(user, ...)` would
//     collide with the domain-side one, and db/index.ts spreads both modules
//     into one schema object, so the collision is silent.
//  3. `account.issuer` is added by hand — Better Auth >= 1.7 requires it, so
//     without it every sign-up fails with "The field \"issuer\" does not
//     exist in the \"account\" Drizzle schema".
//  4. `.defaultNow()` is added to `session.updatedAt` and
//     `account.updatedAt`. The CLI emits `$onUpdate` alone, which fires on
//     UPDATE and not INSERT, leaving a NOT NULL column with no default.
//  5. `account` gains a unique index on (issuer, accountId) — the pair Better
//     Auth treats as an account's stable identity. The CLI emits no such
//     constraint, so duplicate rows could make account lookup ambiguous.
//
// Note: these timestamps are `timestamp` (no time zone), unlike the domain
// tables which use timestamptz. That is Better Auth's choice; it stays
// self-consistent because Better Auth both writes and reads them. Keep the
// database and Node process in UTC and it is a non-issue.
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  // Primary login identifier — phone + OTP, not email/password.
  phoneNumber: text("phone_number").unique(),
  phoneNumberVerified: boolean("phone_number_verified"),
  // Deviation 1: .notNull() added on top of the CLI output.
  role: text("role").default("user").notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Deviation 4: `.defaultNow()` added. The CLI emits $onUpdate only, which
    // fires on UPDATE and not INSERT, leaving a NOT NULL column with no
    // default that any direct insert trips over.
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  table => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    // Deviation 3: required by Better Auth >= 1.7, which scopes account
    // identity by issuer. The standalone CLI is pinned at 1.4.x and does not
    // emit it, so it will be missing again after any regeneration.
    // Values are synthetic: `local:credential` for password accounts,
    // `local:oauth:<provider>` for social ones.
    issuer: text("issuer").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Deviation 4, as on `session` above.
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [
    index("account_user_id_idx").on(table.userId),
    // (issuer, accountId) is Better Auth's "stable provider-side key used to
    // recognize an account" — findAccountOwnerByKey() looks up by exactly this
    // pair. Nothing in the generated schema enforces it, so concurrent
    // sign-ins or link requests could insert duplicates and make that lookup
    // ambiguous. Deviation 5: reapply after regenerating.
    uniqueIndex("account_issuer_account_id_idx").on(table.issuer, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  table => [index("verification_identifier_idx").on(table.identifier)],
);
