import { smsEnabled } from "@/lib/sms";

import type { SchoolContext } from "./01-school";

/**
 * One fee-reminder batch, so the SMS ledger has something in it.
 *
 * §6 says this table exists to answer two questions — what are we spending,
 * and did that parent actually get it — and neither can be shown against an
 * empty table.
 *
 * **Scoped to one class, never the whole school.** Not for runtime: for the
 * phone numbers. The demo's guardians carry fabricated Kenyan mobile numbers,
 * and numbers that look invented are not necessarily unassigned — texting four
 * hundred of them would be at best a bill and at worst a message to a stranger
 * about a child who does not exist. One class is enough to fill a screen.
 *
 * The same care decides whether it sends at all. With no provider configured
 * the run stays a dry run, which is honest — the preview is what a bursar sees
 * first anyway, and it is the part worth demonstrating. A deployment that wants
 * a populated ledger configures Africa's Talking **against the sandbox**, which
 * delivers to a simulator and nowhere else.
 */
export interface Messaging {
  sent: number;
  previewed: number;
  estimatedCostCents: number;
  dryRun: boolean;
}

export async function seedMessaging(ctx: SchoolContext): Promise<Messaging> {
  const bursar = ctx.api("bursar");

  // Grade 8, which is small, boards some of its children and therefore has the
  // largest balances — the class a bursar would actually chase first.
  const gradeEight = ctx.gradeLevels.find(g => g.sequence === 8)!;

  const result = await bursar.post("/sms/fee-reminders", {
    gradeLevelId: gradeEight.id,
    minBalanceCents: 100_00,
    dryRun: !smsEnabled,
  });

  return {
    sent: result.sent,
    previewed: result.recipients,
    estimatedCostCents: result.estimatedCostCents,
    dryRun: result.dryRun,
  };
}
