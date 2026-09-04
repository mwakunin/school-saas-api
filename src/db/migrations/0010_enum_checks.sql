-- Every remaining `.$type<"a" | "b">()` column, said in the database too.
--
-- `.$type<>()` constrains this codebase and nothing else: the columns are
-- `text`, and Postgres takes whatever a seed, a backfill or a hand-run
-- correction gives it. What follows is quiet rather than loud — an
-- unrecognised value is not a crash, it is a row that stops matching filters.
-- A pupil whose status is neither `active` nor `withdrawn` is missing from the
-- register and from the leavers' list at the same time.
--
-- No backfill needed and none silently skipped: every value in these tables is
-- written through a Zod-validated route or the seed. A plain ADD CONSTRAINT
-- (no NOT VALID) validates the existing rows here, so if that is ever untrue
-- this migration says so instead of accepting the table unchecked.
--
-- `students.sex` is nullable, and NULL passes a CHECK. Plenty of admission
-- forms leave it blank; what the constraint refuses is a third spelling.
--
-- `performance_level` is absent because it is a real pgEnum already.

ALTER TABLE "assessments" ADD CONSTRAINT "assessments_kind_known" CHECK ("assessments"."kind" IN ('exam', 'cat', 'project', 'practical', 'observation', 'national'));--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_boarding_status_known" CHECK ("enrollments"."boarding_status" IN ('day', 'boarder'));--> statement-breakpoint
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_boarding_status_known" CHECK ("fee_structures"."boarding_status" IN ('day', 'boarder'));--> statement-breakpoint
ALTER TABLE "grade_levels" ADD CONSTRAINT "grade_levels_phase_known" CHECK ("grade_levels"."phase" IN ('primary', 'junior'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_known" CHECK ("memberships"."role" IN ('admin', 'bursar', 'teacher', 'guardian'));--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_status_known" CHECK ("mpesa_transactions"."status" IN ('unmatched', 'allocated', 'rejected'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_known" CHECK ("payments"."method" IN ('mpesa', 'bank', 'cash', 'cheque'));--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_status_known" CHECK ("schools"."status" IN ('trial', 'active', 'suspended', 'demo'));--> statement-breakpoint
ALTER TABLE "score_attachments" ADD CONSTRAINT "score_attachments_kind_known" CHECK ("score_attachments"."kind" IN ('image', 'audio', 'video', 'document'));--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_sex_known" CHECK ("students"."sex" IN ('male', 'female'));--> statement-breakpoint
ALTER TABLE "students" ADD CONSTRAINT "students_status_known" CHECK ("students"."status" IN ('active', 'transferred_out', 'graduated', 'withdrawn', 'deceased'));