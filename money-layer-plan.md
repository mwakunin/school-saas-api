# Money layer — plan

Status: **Phase 1 allocations built, Phases 2 and 3 proposal.** Written 2026-09-10.

Companion to `CLAUDE.md`, which stays the source of truth for conventions. Every
rule referenced by number below is from its §3.

---

## 1. What this is

school-saas can answer _"what does this family owe?"_ It cannot answer
_"what does this school owe?"_, and it cannot answer _"which term did this
payment settle?"_

This document is the plan for closing both, in the order that a bursar would
feel them.

It is written against `tourops`, where the same layer already exists in
production shape — but **the goal is the functionality, not the structure.**
Where tourops carries a concept schools do not have (currency conversion,
deposit schedules, commission), it is named here and dropped. A school-saas
table should be called what a bursar calls it.

---

## 2. What exists today, honestly

The receivables side is good and mostly finished. It is worth being precise
about that, because the temptation with a plan like this is to rebuild things
that already work.

```
fee_structures ──► fee_items          templates
                     │
                     ▼  copied at generation time (never joined at read time)
                  invoices ──► invoice_lines    the printed document
                     │
mpesa_transactions ──┼──► payments              the ledger entry
   (raw, append-only)│
                     ▼
                 lib/balances.ts       sum(invoices) - sum(payments)
```

What is genuinely solved:

- **The raw/allocated split.** `mpesa_transactions` is append-only with a
  trigger enforcing it; `payments` is the interpretation. "Where did this
  KES 15,000 go" is always answerable, and every mis-allocation is reversible.
- **Strict matching with a human queue.** No fuzzy fallback. A wrong automatic
  allocation is worse than none, and the reconciliation queue is treated as the
  core bursar workflow rather than an edge case.
- **One definition of a balance.** `lib/balances.ts` is the only place the
  formula is written, and it handles the two cases the naive version misses —
  voided invoices are not owed, reversed payments were not paid.
- **Tenant isolation.** RLS with `FORCE`, composite foreign keys, a separate
  unprivileged role, and tests that fail the build on a stray owner-connection
  import.

None of that needs revisiting. What follows builds on it.

---

## 3. The three gaps

### Gap 1 — a payment cannot say which invoice it settled

`payments.invoiceId` is a single nullable uuid, and:

```ts
uniqueIndex("payments_one_live_per_mpesa_transaction")
  .on(t.mpesaTransactionId)
  .where(sql`${t.reversedAt} IS NULL`);
```

One live payment per M-Pesa confirmation, and one invoice per payment. So a
confirmation can settle **at most one** invoice.

The code already knows. From `reconciliation.schemas.ts`:

> _Deliberately no `invoiceId`. […] The money lands as a credit on the
> student's account, which is what a parent paying "school fees" has actually
> done. Naming a term is a separate act, and guessing the oldest unpaid invoice
> is wrong every time someone pays next term in advance._

That decision is right, and this gap is the "separate act" it defers. **Phase 1
is building it, not correcting it.**

**What is not broken:** the family's total balance. A credit-on-account payment
has no `invoiceId`, and `lib/balances.ts` sums invoices and payments per
student, so the arithmetic is correct.

**What is missing** is everything per-invoice:

- _Is Term 2 cleared?_ — unanswerable
- _How old is this arrear?_ — unanswerable, so no ageing and no dunning by age
- A parent pays KES 20,000 covering KES 8,000 of Term 2 arrears and KES 12,000
  of Term 3. Today that is one undifferentiated credit.

### Gap 2 — there is no cost side at all

Searched the whole tree for `supplier|payable|counterparty|vendor|expense|purchase|procure`.
Zero matches, in `src/` and in `CLAUDE.md`.

A school spends money constantly: teacher salaries, the posho mill, food
suppliers, textbooks, exam council fees, electricity, water, bus diesel and
repairs, capitation reconciliation with the ministry. None of it exists here.

The consequence is that the system cannot answer the question a board of
governors asks every term: **did we run a surplus?**

### Gap 3 — "ledger" here means a statement, not a ledger

`payments` is a ledger _of a student's account_. There is no chart of accounts,
no double entry, and therefore no trial balance and no income statement.

This matters less than Gap 2 and should be built after it, but it is worth
naming now because Phase 2's shape depends on whether Phase 3 is ever coming.

---

## 4. Before any of it: the sequencing objection

`CLAUDE.md` §7 step 7 reads:

> **Put it in front of one real school before writing anything else.**

That instruction is still unsatisfied, and it outranks this document.

Everything below is worth building _eventually_. Almost none of it is worth
building **instead of** getting the receivables side in front of a bursar who
will tell you which half of it is wrong. The demo seed already demonstrated the
cost of building ahead of reality: §7 records that the first run against three
hundred children found real gaps within minutes, after every step from 3 to 8
had been tested against two or three hand-made rows.

**Recommended order:** Phase 1 (small, closes a daily bursar frustration) →
a real school → then Phase 2 informed by what they actually complain about.

Phase 2 is a month of work aimed at a user nobody has met yet.

---

## 5. Phase 1 — allocations

**Size:** small. One table, one endpoint, a change to `lib/balances.ts`.
**Value:** high, and immediate. Bursars hit this daily.

### The shape

The many-to-many that is currently missing between what is owed and what was
paid. tourops calls it `allocations` and it is the centre of gravity of its
money layer; the same name works here.

```ts
export const allocations = pgTable("allocations", {
  id: uuid().primaryKey().defaultRandom(),
  schoolId: uuid("school_id").notNull(),

  paymentId: uuid("payment_id").notNull(),
  invoiceId: uuid("invoice_id").notNull(),

  amountCents: integer("amount_cents").notNull(),

  allocatedBy: text("allocated_by").references(() => user.id),
  allocatedAt: timestamp("allocated_at").defaultNow().notNull(),

  // Rule 5: nothing hard-deletes. Un-allocating is a reversal, not a DELETE,
  // for the same reason reversing a payment is.
  reversedAt: timestamp("reversed_at"),
  reversalReason: text("reversal_reason"),
}, t => [
  // §4 layer 4: composite foreign keys, or a cross-tenant pointer is legal.
  foreignKey({
    columns: [t.schoolId, t.paymentId],
    foreignColumns: [payments.schoolId, payments.id],
  }),
  foreignKey({
    columns: [t.schoolId, t.invoiceId],
    foreignColumns: [invoices.schoolId, invoices.id],
  }),
  index().on(t.schoolId, t.paymentId),
  index().on(t.schoolId, t.invoiceId),
  wholeShillingsPositive("allocations_amount_whole", t.amountCents),
]);
```

### Rules it has to carry

- **An allocation may never exceed its payment.** The sum of live allocations
  for a payment ≤ `payments.amountCents`. Enforced in the service inside the
  transaction, and tested — a check constraint cannot see sibling rows.
- **Nor its invoice.** Sum of live allocations for an invoice ≤
  `invoices.totalCents`. Over-allocating an invoice is how a school ends up
  reporting a term as over-collected while a family is still in arrears.
- **`payments.invoiceId` stays, and stays authoritative for nothing.** It
  becomes legacy. Either backfill it into `allocations` and drop it, or leave
  it and have exactly one reader — but not both, because two answers to "which
  invoice did this settle" is the drift `lib/balances.ts` exists to prevent.
  **Backfilling and dropping is the right call**; a column that means something
  historical and nothing current is a trap for the next reader.
- **Allocation is a separate act from matching**, exactly as
  `reconciliation.schemas.ts` argues. The matcher still lands money as credit.
  A bursar then chooses where it goes, and may choose more than one invoice.

### What changes elsewhere

- `lib/balances.ts` gains per-invoice balances alongside per-student. The
  student-level formula does **not** change — it stays
  `sum(invoices) - sum(payments)`, because an unallocated credit still reduces
  what a family owes. That is worth a comment, since the two formulas will look
  inconsistent to someone reading quickly.
- Ageing becomes possible: `invoices.dueOn` minus today, on invoices whose live
  allocations do not cover them.
- Fee-reminder SMS can finally say _which_ term is outstanding.

### Endpoints

```
POST   /reconciliation/payments/{id}/allocations   allocate to one or more invoices
DELETE /reconciliation/allocations/{id}            reverse an allocation
GET    /fees/invoices/{id}/allocations             what settled this invoice
```

### Built

Shipped as one migration (0015): the table, the backfill of every existing
`payments.invoice_id` into an allocation, and the drop of that column — the
call this section already argued for, since a column that means something
historical and nothing current is a trap for the next reader.

Three deviations from the sketch above, each deliberate:

- **`studentId` sits on the allocation and both foreign keys are three
  columns wide** — `(school_id, payment_id, student_id)` and
  `(school_id, invoice_id, student_id)`, backed by a new unique on `payments`.
  A payment recorded for child A against child B's invoice is now
  _unrepresentable_ rather than refused in code; `db/rls.test.ts` pins the
  foreign keys, not the service.
- **Un-allocating is `POST /allocations/{id}/reverse`, not DELETE.** Rule 5
  was always going to win; the endpoint list above was written before it was
  applied to allocations.
- **A reversal carries its reason, paired by a CHECK** —
  `(reversed_at IS NULL) = (reversal_reason IS NULL)` — the same shape
  payments use.

The two invariants live in `lib/allocations.ts` and nowhere else: lock the
payment `FOR UPDATE`, then the invoices in id order (deadlock avoidance), sum
the live siblings on each side, insert or refuse — 409 when resubmitting
cannot help (reversed payment, a race lost by moments), 422 with a field
otherwise. An allocation is live only while both it and its payment stand;
that is a property of a join, not a column, so reversing a payment frees its
invoice's capacity without touching the allocation. Balances, the verify
receipt's term, and the seed — which records, then allocates, the way a
bursar does — all read through that rule.

---

## 6. Phase 2 — the cost side

**Size:** large. **Value:** high but unproven until a school asks for it.

### Vocabulary

tourops uses `counterparty / obligation / settlement` precisely so the module
can carry both directions and both products. That abstraction earned its keep
there. **Here it should not be copied.** A bursar does not have counterparties,
they have suppliers; they do not have obligations, they have bills.

| tourops                  | school-saas     | why                                        |
| ------------------------ | --------------- | ------------------------------------------ |
| `counterparties`         | `suppliers`     | the only outbound party a school has       |
| `obligations` (payable)  | `bills`         | what a bursar calls the paper on the spike |
| `settlements` (outbound) | `disbursements` | money leaving                              |
| `allocations`            | `allocations`   | same concept, already Phase 1              |
| `fx_rates`               | —               | **drop.** Schools are KES-only             |
| deposit schedules        | —               | **drop.** No supplier deposits             |
| commission (bps)         | —               | **drop.** No agents                        |

Dropping three of those is most of why this is smaller than tourops' money
layer.

### Tables

```
suppliers          who the school buys from. name, contact, payment terms,
                   M-Pesa/bank details, category (food, books, utilities,
                   transport, payroll, other)

bills              what is owed to a supplier. supplier_id, description,
                   amount_cents, issued_on, due_on, status (open/void/
                   written_off — lifecycle only, never "paid")

bill_lines         optional. Only if schools actually itemise; most will not.
                   Defer until asked.

disbursements      money that left. supplier_id, method (mpesa/bank/cash/
                   cheque), amount_cents, paid_on, reference, recorded_by,
                   reversed_at
```

`allocations` from Phase 1 extends to cover `(disbursement → bill)` as well as
`(payment → invoice)`. **Decide deliberately** whether that is one polymorphic
table or two: one table with a `kind` discriminator loses the composite foreign
keys that §4 layer 4 depends on. **Two tables is the safer call** —
`allocations` and `bill_allocations` — precisely because the FK guarantee is
worth more than the deduplication.

### The rule that has to hold

Same as receivables, and for the same reason:

> **Whether a bill is settled is derived from allocations, never read from
> `status`.** `status` is lifecycle only: open, void, written_off.

This is the single most important thing to carry over from tourops. A `paid`
boolean drifts the first time a payment is reversed, and then the school has
two answers to what it owes.

### Payroll

Deliberately out of scope, and worth stating so nobody assumes otherwise.
Teacher salaries are the largest line in a school's budget and come with PAYE,
NSSF, SHIF and NHIF. That is a payroll product, not a money layer, and getting
it wrong has statutory consequences. Salaries can enter as ordinary `bills`
against a `payroll` supplier until somebody decides to build it properly.

### Capitation

Government capitation is inbound money that is not a fee and not attached to a
student. It does not fit `invoices`, and forcing it there would corrupt every
per-family balance. It wants its own small table, or a `receipts` concept that
`payments` becomes a special case of. **Open question — do not guess.** Ask a
bursar how they currently record it.

---

## 7. Phase 3 — double entry

**Size:** medium. **Value:** low until a school's accountant asks, then
suddenly non-negotiable.

`ledger_entries` with a small fixed chart of accounts: fees income, capitation
income, cash at bank, cash at M-Pesa, accounts receivable, accounts payable,
salaries, supplies, utilities, transport.

Two rules from tourops that are worth taking exactly:

- **Every entry is written by a service, never a handler.** Entries come from
  events (invoice raised, payment received, bill entered, disbursement made),
  not from CRUD.
- **A failed accrual goes to an outbox and is retried**, rather than being
  swallowed or blocking the operation that triggered it. tourops added
  `ledger_outbox` after finding that a ledger write failing inside a booking
  transaction either lost the entry or lost the booking.

Only worth building once Phase 2 is real. A double-entry ledger over
receivables alone is an income statement with no expenses, which no accountant
will accept and no head teacher will read.

---

## 8. What not to port

Named explicitly so nobody ports them out of symmetry:

- **`fx_rates` and multi-currency.** Schools bill in KES and pay in KES.
  tourops needs it because a safari operator quotes USD to a guest and pays a
  lodge in KES; a school has no such split. Every conversion is a rounding
  decision waiting to be wrong.
- **Deposit schedules.** No supplier asks a school for 30% up front.
- **Commission in basis points.** No agents.
- **`reportingFx` and base-currency conversion on every ledger row.** Falls
  away with fx.
- **Generated decimal columns mirroring cents.** tourops carries
  `total_price` as a `GENERATED ALWAYS AS (cents/100)` column for an inherited
  API contract. school-saas has no such contract and rule 3 is unambiguous —
  cents only, and format at the edge.

---

## 9. Risks

**The allocation invariants are not expressible as check constraints.** "Sum of
allocations ≤ payment amount" spans rows, so it lives in a service inside a
transaction. That is the weakest link in Phase 1 and deserves the most tests —
concurrent allocation of the same payment especially.

**Two allocation tables will be tempting to merge.** Resist it, or write down
why the merge was safe. The composite foreign keys are a §4 layer, not a style
preference.

**Phase 2 doubles the surface a bursar has to learn.** The receivables side is
already the thing they will pay for. A cost side they did not ask for, arriving
before they have used the first, is how a product gets described as
complicated.

**`payments.invoiceId` will get left behind.** Backfilling and dropping it is a
migration nobody enjoys, and skipping it leaves two sources of truth. Do it in
the same phase or it will not happen.

---

## 10. Open questions

Real ones, for a bursar rather than for us:

1. How do you currently record capitation? Against the school, against a class,
   or not at all?
2. When a parent pays a lump sum covering two terms, what do you do today —
   and what do you _wish_ the system did?
3. Do you itemise supplier bills, or is it one line and an amount?
4. Who approves a payment to a supplier before it leaves? Is there a second
   signature, and should the system know about it?
5. Does the board ever ask for a term-by-term surplus figure, or is that a
   once-a-year audit question?

Question 2 decides how much of Phase 1 is enough. Question 4 decides whether
Phase 2 needs an approval state or just a record.
