-- ============================================================
-- Storage Books — Supabase Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Companies (your 3 LLCs)
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- Transaction categories (global, shared across companies)
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null check (type in ('income', 'expense')),
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Transactions
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade not null,
  category_id uuid references categories(id),
  date date not null,
  description text,
  original_description text,
  amount decimal(12,2) not null, -- positive = income, negative = expense
  source text check (source in ('chase', 'suncoast', 'amex', 'manual', 'easystorage')),
  source_type text check (source_type in ('bank', 'credit_card')),
  expense_type text check (expense_type in ('opex', 'one_time', 'capex', 'owner_addback')),
  is_autopayment boolean default false,
  notes text,
  imported_at timestamptz default now(),
  created_at timestamptz default now()
);

-- Transaction comments (for partner collaboration)
create table if not exists transaction_comments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade not null,
  user_id uuid references auth.users(id) not null,
  body text not null,
  created_at timestamptz default now()
);

-- Monthly bank balances (for month-end reconciliation)
create table if not exists monthly_balances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade not null,
  account_name text not null,
  source text,
  year int not null,
  month int not null check (month between 1 and 12),
  balance decimal(12,2) not null,
  notes text,
  created_at timestamptz default now(),
  unique(company_id, account_name, year, month)
);

-- Balance sheet manual entries (assets & liabilities per entity)
create table if not exists balance_sheet_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade not null,
  name text not null,
  type text not null check (type in ('asset', 'liability')),
  amount decimal(12,2) not null,
  as_of_date date not null,
  notes text,
  created_at timestamptz default now()
);

-- User roles (owner = full access, viewer = read + comment)
create table if not exists user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role text not null check (role in ('owner', 'viewer')),
  created_at timestamptz default now(),
  unique(user_id)
);

-- ============================================================
-- Indexes
-- ============================================================
create index if not exists idx_transactions_company_date on transactions(company_id, date);
create index if not exists idx_transactions_category on transactions(category_id);
create index if not exists idx_transactions_source_type on transactions(source_type);

-- Bank P&L configuration
create table if not exists bank_pl_categories (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references companies(id) on delete cascade,
  category_id uuid references categories(id) on delete cascade not null,
  created_at timestamptz default now()
);

create table if not exists bank_pl_exclusions (
  id uuid default gen_random_uuid() primary key,
  company_id uuid references companies(id) on delete cascade,
  transaction_id uuid references transactions(id) on delete cascade not null,
  created_at timestamptz default now()
);

alter table bank_pl_categories enable row level security;
alter table bank_pl_exclusions enable row level security;

create policy "authenticated read bank_pl_categories" on bank_pl_categories for select to authenticated using (true);
create policy "owner write bank_pl_categories" on bank_pl_categories for all to authenticated using (get_my_role() = 'owner');
create policy "authenticated read bank_pl_exclusions" on bank_pl_exclusions for select to authenticated using (true);
create policy "owner write bank_pl_exclusions" on bank_pl_exclusions for all to authenticated using (get_my_role() = 'owner');
create index if not exists idx_monthly_balances_company on monthly_balances(company_id, year, month);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table companies enable row level security;
alter table categories enable row level security;
alter table transactions enable row level security;
alter table transaction_comments enable row level security;
alter table monthly_balances enable row level security;
alter table balance_sheet_entries enable row level security;
alter table user_roles enable row level security;

-- Helper: get current user's role
create or replace function get_my_role()
returns text as $$
  select role from user_roles where user_id = auth.uid()
$$ language sql security definer;

-- Companies: all authenticated users can read; only owners can write
create policy "authenticated read companies" on companies for select to authenticated using (true);
create policy "owner write companies" on companies for all to authenticated using (get_my_role() = 'owner');

-- Categories: all authenticated can read; only owners can write
create policy "authenticated read categories" on categories for select to authenticated using (true);
create policy "owner write categories" on categories for all to authenticated using (get_my_role() = 'owner');

-- Transactions: all authenticated can read; only owners can write
create policy "authenticated read transactions" on transactions for select to authenticated using (true);
create policy "owner write transactions" on transactions for all to authenticated using (get_my_role() = 'owner');

-- Comments: all authenticated can read and insert; only owner of comment can delete
create policy "authenticated read comments" on transaction_comments for select to authenticated using (true);
create policy "authenticated insert comments" on transaction_comments for insert to authenticated with check (user_id = auth.uid());
create policy "owner delete comments" on transaction_comments for delete to authenticated using (user_id = auth.uid());

-- Monthly balances: all read; owner write
create policy "authenticated read balances" on monthly_balances for select to authenticated using (true);
create policy "owner write balances" on monthly_balances for all to authenticated using (get_my_role() = 'owner');

-- Balance sheet: all read; owner write
create policy "authenticated read bs" on balance_sheet_entries for select to authenticated using (true);
create policy "owner write bs" on balance_sheet_entries for all to authenticated using (get_my_role() = 'owner');

-- User roles: users can read their own role
create policy "read own role" on user_roles for select to authenticated using (user_id = auth.uid());

-- ============================================================
-- Seed: Default Categories
-- ============================================================
insert into categories (name, type, sort_order) values
  ('Rental Income', 'income', 1),
  ('Late Fees', 'income', 2),
  ('Admin / Setup Fees', 'income', 3),
  ('Merchandise Sales', 'income', 4),
  ('Truck Rental Income', 'income', 5),
  ('Insurance Income', 'income', 6),
  ('Other Income', 'income', 99),
  ('Property Tax', 'expense', 10),
  ('Insurance', 'expense', 11),
  ('Utilities', 'expense', 12),
  ('Maintenance & Repairs', 'expense', 13),
  ('Landscaping / Snow Removal', 'expense', 14),
  ('Management Fees', 'expense', 15),
  ('Advertising & Marketing', 'expense', 16),
  ('Software & Subscriptions', 'expense', 17),
  ('Professional Fees', 'expense', 18),
  ('Bank Fees & Charges', 'expense', 19),
  ('Credit Card Fees', 'expense', 20),
  ('Office Supplies', 'expense', 21),
  ('Travel & Auto', 'expense', 22),
  ('Payroll / Labor', 'expense', 23),
  ('Mortgage / Loan Interest', 'expense', 24),
  ('Loan Service (Interest)', 'expense', 24),
  ('Loan Service (Principal)', 'expense', 25),
  ('Depreciation', 'expense', 26),
  ('Building Improvement', 'expense', 27),
  ('Payroll Taxes', 'expense', 23),
  ('Legal Fees', 'expense', 18),
  ('Paid to TolSpain IV', 'expense', 99),
  ('Other Expense', 'expense', 99)
on conflict (name) do nothing;

-- ── Report Settings (key/value store for branding) ──────────────────────────
create table if not exists report_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text,
  updated_at timestamptz default now()
);

-- Enable RLS
alter table report_settings enable row level security;
create policy "report_settings_select" on report_settings for select using (true);
create policy "report_settings_insert" on report_settings for insert with check (true);
create policy "report_settings_update" on report_settings for update using (true);

-- ── Storage bucket for report assets (logo, etc.) ────────────────────────────
-- Run this separately in the Supabase dashboard (Storage > New Bucket):
--   Name: report-assets
--   Public: true
-- Or via SQL:
insert into storage.buckets (id, name, public)
values ('report-assets', 'report-assets', true)
on conflict (id) do nothing;

create policy "report_assets_select" on storage.objects
  for select using (bucket_id = 'report-assets');
create policy "report_assets_insert" on storage.objects
  for insert with check (bucket_id = 'report-assets');
create policy "report_assets_update" on storage.objects
  for update using (bucket_id = 'report-assets');

-- ── Pro Forma (next-year budget per facility) ───────────────────────────────
-- assumptions: { baseline, rentIncreases: [...], lines: { [category]: { method, value } } }
-- overrides:   { [category]: { [month 1-12]: amount } } — manual cell edits
create table if not exists pro_forma (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade not null,
  year int not null,
  assumptions jsonb not null default '{}'::jsonb,
  overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique(company_id, year)
);

alter table pro_forma enable row level security;
create policy "authenticated read pro_forma" on pro_forma for select to authenticated using (true);
create policy "owner write pro_forma" on pro_forma for all to authenticated using (get_my_role() = 'owner');
