import type { AppDb } from "@/db";
import type { AuditAction } from "@/db/schema";

import { auditLog } from "@/db/schema";

/**
 * Who changed a mark, who reversed a payment, who released a report card.
 *
 * CLAUDE.md §6 asks for this before v1 and names those three events. It is a
 * safeguard and a sales point at once: a product holding children's records
 * and school money should answer "who did this, and when" from a screen rather
 * than a database dump, and a head asked that by a parent or a board needs the
 * answer in front of them.
 *
 * Two rules make it worth having rather than decorative.
 *
 * **Written inside the same transaction as the thing it records.** An entry
 * that survived a rolled-back action would be a lie, and one lost when the
 * action succeeded would be a gap nobody could see. `c.get('db')` is the
 * request transaction, so passing it here gets both for free — the log commits
 * with the change or not at all.
 *
 * **Append-only in the database, not by convention.** The runtime role holds
 * INSERT and SELECT on `audit_log` and neither UPDATE nor DELETE. A log the
 * application could rewrite is evidence of nothing; the person who wishes an
 * entry said something different is precisely the person who must not be able
 * to change it.
 */
export async function recordAudit(
  db: AppDb,
  entry: {
    schoolId: string;
    /** Null for something the system did with nobody asking. */
    actorId?: string | null;
    action: AuditAction;
    entityType: string;
    entityId?: string | null;
    /** One line a human can read without joining anything. */
    summary: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    schoolId: entry.schoolId,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    summary: entry.summary,
    detail: entry.detail ?? null,
  });
}
