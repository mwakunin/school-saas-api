-- No backfill needed, and this is worth stating rather than leaving a reader
-- to work out: `level_reduction` arrived in 0008 as NOT NULL DEFAULT
-- 'mode_ties_low', so every row that exists already holds that value. A plain
-- ADD CONSTRAINT (no NOT VALID) validates the whole table here, which is what
-- proves it rather than assuming it — if a row ever did hold something else,
-- this migration fails loudly instead of admitting it into a frozen snapshot.
ALTER TABLE "term_results" ADD CONSTRAINT "term_results_level_reduction_known" CHECK ("term_results"."level_reduction" IN ('mode_ties_low', 'mode_ties_high', 'lowest'));
