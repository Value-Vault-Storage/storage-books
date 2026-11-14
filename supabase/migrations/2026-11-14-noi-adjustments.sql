-- ============================================================
-- NOI adjustments: documented exclusions from NOI
-- Run once in the Supabase SQL Editor.
--
-- Replaces bank_pl_exclusions (which recorded *that* a transaction was
-- excluded, per view, with no reason). An adjustment is a fact about the
-- transaction, so it applies in every view: Bank P&L, Overview, Deal Room,
-- Debt & Equity. bank_pl_exclusions is left in place (unused) for rollback.
-- ============================================================

create table if not exists noi_adjustments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade not null unique,
  -- capex         capital improvement (below NOI; a reserve replaces it)
  -- non_recurring storm damage, deferred-maintenance catch-up, one-off events
  -- owner         owner / non-operating
  -- reimbursed    reimbursed by insurance or a third party
  -- unreviewed    carried over from the old exclusions; needs a reason
  treatment text not null check (treatment in ('capex', 'non_recurring', 'owner', 'reimbursed', 'unreviewed')),
  -- Portion excluded, as a positive amount. null = the whole transaction.
  amount decimal(12,2) check (amount is null or amount > 0),
  reason text not null default '',
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- A reviewed adjustment must say why
  constraint noi_adjustments_reason_required check (treatment = 'unreviewed' or length(trim(reason)) > 0)
);

create index if not exists idx_noi_adjustments_transaction on noi_adjustments(transaction_id);

alter table noi_adjustments enable row level security;
create policy "authenticated read noi_adjustments" on noi_adjustments for select to authenticated using (true);
create policy "owner write noi_adjustments" on noi_adjustments for all to authenticated
  using (get_my_role() = 'owner') with check (get_my_role() = 'owner');

-- Carry over existing exclusions (from any view) as "needs reason".
-- Note: exclusions used to be per view, so a transaction excluded in only
-- one view is now excluded everywhere.
insert into noi_adjustments (transaction_id, treatment, reason, created_by)
select distinct e.transaction_id, 'unreviewed', '', null::uuid
from bank_pl_exclusions e
join transactions t on t.id = e.transaction_id
on conflict (transaction_id) do nothing;
