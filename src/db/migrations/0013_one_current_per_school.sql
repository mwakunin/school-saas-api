-- Reconcile before constraining, because until now nothing stopped duplicates.
--
-- This is the difference between adding a CHECK and adding a UNIQUE over data
-- that was previously unconstrained. A CHECK asserts an invariant that already
-- held, and letting it validate is what PROVES that (see 0009 and 0010). This
-- index ESTABLISHES an invariant that did not hold: the handlers cleared the
-- flag and then set it, which races against itself, so two current rows for one
-- school is exactly the state the code before this migration could produce.
--
-- Failing on those rows would be a decision too, and a bad one — a blocked
-- deploy, at the worst moment, over data the previous version was entitled to
-- write, with nothing telling the operator which row to keep. Deciding here is
-- better, and the rule is deterministic rather than arbitrary: keep the term
-- that started most recently, and the latest academic year, which is what
-- "current" meant in every case anybody would have intended.
--
-- On a database with no duplicates — which is every one that exists today —
-- both statements match nothing and cost a single scan.

UPDATE "academic_years" SET "is_current" = false
WHERE "is_current"
  AND "id" NOT IN (
    SELECT DISTINCT ON ("school_id") "id"
    FROM "academic_years"
    WHERE "is_current"
    ORDER BY "school_id", "year" DESC, "id"
  );
--> statement-breakpoint

UPDATE "terms" SET "is_current" = false
WHERE "is_current"
  AND "id" NOT IN (
    SELECT DISTINCT ON ("school_id") "id"
    FROM "terms"
    WHERE "is_current"
    ORDER BY "school_id", "starts_on" DESC, "id"
  );
--> statement-breakpoint

CREATE UNIQUE INDEX "academic_years_one_current_per_school" ON "academic_years" USING btree ("school_id") WHERE "academic_years"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "terms_one_current_per_school" ON "terms" USING btree ("school_id") WHERE "terms"."is_current";
