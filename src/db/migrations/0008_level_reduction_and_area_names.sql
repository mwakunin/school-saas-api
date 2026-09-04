ALTER TABLE "term_results" ADD COLUMN "level_reduction" text DEFAULT 'mode_ties_low' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_areas_school_name_unique" ON "learning_areas" USING btree ("school_id",lower("name"));--> statement-breakpoint

-- DELETE on `term_results`, and on nothing else added since.
--
-- CLAUDE.md §3 rule 5 protects "students, invoices, payments, and scores" —
-- records of fact, which a school may be asked to account for years later. A
-- term result is none of those. It is a COMPUTATION over
-- `assessment_scores`, recomputed from them on every run and reconstructible
-- from them at any time; the scores themselves keep no DELETE, and the report
-- card that freezes a result is a separate, immutable record.
--
-- The grant exists because recomputing has to be able to remove a result that
-- no longer has anything behind it. Withdrawing an assessment used to leave
-- the previous figure standing, so `/term-results` and any report card
-- finalised afterwards reported a mark derived from data no longer published.
-- Stale is worse than absent here: absent reads as "not marked yet", stale
-- reads as fact.
GRANT DELETE ON "term_results" TO school_app;
