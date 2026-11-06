-- Better Auth moves to its own role, `school_auth` (db/roles.sql).
--
-- Until now `school_app`, the role every tenant request runs as, held full
-- DML on the identity tables, because Better Auth shared its connection. The
-- identity tables carry no tenant policies (a person may work at two
-- schools), so that role could read every school's session tokens and
-- password hashes: one query bug in any handler away from a cross-school
-- account takeover. Ported from healthcare-api, where the split was made from
-- the start.
--
-- Requires db/roles.sql to have created `school_auth` first; this migration
-- fails loudly otherwise, which is the right outcome.
--
-- Rollout. The API is not live yet, so this lands with the code that signs in
-- as `school_auth` and no old instance is running. On a live system it would
-- cut off instances still running the old code, which sign in as
-- `school_app`, until they were replaced: there it must be split, granting
-- `school_auth` in one release and revoking from `school_app` in the next.

REVOKE ALL ON "user", "session", "account", "verification" FROM school_app;
--> statement-breakpoint

-- What tenant handlers read about a person, and nothing else: a staff list
-- and the audit log show names and emails, enrollment matches a guardian by
-- email, and the parent portal shows a guardian their own contact details.
-- Not `role`, which is the platform's superadmin flag and reaches the app
-- through the session.
GRANT SELECT ("id", "name", "email", "email_verified", "phone_number", "phone_number_verified")
  ON "user" TO school_app;
--> statement-breakpoint

-- Better Auth needs full DML: signing out deletes a session, and expired
-- verification rows are cleaned up in place.
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "session", "account", "verification" TO school_auth;
