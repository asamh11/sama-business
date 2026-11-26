-- Sama Business foundation 0001
-- Tenancy + double-entry ledger + subscriptions. Targets Supabase (Postgres 15+).
-- Rules enforced HERE, not only in the app: balanced entries, immutability,
-- tenant isolation (RLS), atomic posting, idempotency.

create extension if not exists pgcrypto with schema extensions;

create type member_role as enum ('owner','admin','accountant','cashier','viewer');
create type account_type as enum ('asset','liability','equity','revenue','expense');

create table currencies (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  decimals smallint not null check (decimals between 0 and 4)
);
-- Verify SYP decimals against your real practice before the first data is stored.
insert into currencies values ('USD',2),('SYP',2),('EUR',2),('TRY',2),('AED',2),('SAR',2);

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_currency text not null references currencies(code),
  created_at timestamptz not null default now()
);
create table branches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  name text not null,
  unique (id, org_id)
);
create table memberships (
  org_id uuid not null references organizations(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  role member_role not null,
  primary key (org_id, user_id)
);
create table accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  code text not null,
  name text not null,
  type account_type not null,
  is_active boolean not null default true,
  unique (org_id, code),
  unique (id, org_id)
);
-- A cashbox is a named, single-currency view over an asset account.
-- Its balance is always derived from the ledger, never stored.
create table cashboxes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  branch_id uuid,
  name text not null,
  currency text not null references currencies(code),
  account_id uuid not null,
  foreign key (account_id, org_id) references accounts(id, org_id),
  foreign key (branch_id, org_id) references branches(id, org_id)
);

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  branch_id uuid,
  entry_date date not null,
  memo text,
  idempotency_key text not null,
  reverses_entry_id uuid unique references journal_entries(id),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  unique (id, org_id),
  foreign key (branch_id, org_id) references branches(id, org_id)
);
create table journal_lines (
  id bigint generated always as identity primary key,
  entry_id uuid not null,
  org_id uuid not null,
  account_id uuid not null,
  currency text not null references currencies(code),
  debit bigint not null default 0 check (debit >= 0),
  credit bigint not null default 0 check (credit >= 0),
  check ((debit > 0) <> (credit > 0)),
  foreign key (entry_id, org_id) references journal_entries(id, org_id),
  foreign key (account_id, org_id) references accounts(id, org_id)
);
create index on journal_lines (entry_id);
create index on journal_lines (org_id, account_id);

create table audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  actor uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);

-- Posted records are never edited or deleted. Fix mistakes with a reversal.
create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: records are immutable', tg_op, tg_table_name;
end $$;
create trigger journal_entries_immutable before update or delete on journal_entries
  for each row execute function forbid_change();
create trigger journal_lines_immutable before update or delete on journal_lines
  for each row execute function forbid_change();
create trigger audit_logs_immutable before update or delete on audit_logs
  for each row execute function forbid_change();

-- Every entry must balance per currency. Checked at COMMIT, so all lines
-- of an entry can be inserted first.
create function check_entry_balanced() returns trigger language plpgsql as $$
declare n int; bad record;
begin
  select count(*) into n from journal_lines where entry_id = new.entry_id;
  if n < 2 then
    raise exception 'entry % needs at least 2 lines', new.entry_id;
  end if;
  select currency into bad from journal_lines where entry_id = new.entry_id
    group by currency having sum(debit) <> sum(credit) limit 1;
  if found then
    raise exception 'entry % is not balanced in %', new.entry_id, bad.currency;
  end if;
  return null;
end $$;
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function check_entry_balanced();

-- Subscriptions and agent-sold activation codes (only hashes are stored).
create table plans (
  code text primary key,
  name text not null,
  max_branches int not null,
  max_members int not null,
  ai_monthly_quota int not null
);
-- Placeholder limits: tune to your pricing.
insert into plans values ('free','Free',1,2,20),('shop','Shop',3,10,500),('mall','Mall',50,200,5000);
create table subscriptions (
  org_id uuid primary key references organizations(id),
  plan_code text not null references plans(code),
  period_end timestamptz
);
create table activation_codes (
  code_hash bytea primary key,
  plan_code text not null references plans(code),
  months int not null check (months between 1 and 36),
  agent_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  redeemed_org uuid references organizations(id),
  redeemed_at timestamptz
);

-- Tenant isolation ---------------------------------------------------------
create function has_role(p_org uuid, p_roles member_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships
    where org_id = p_org and user_id = (select auth.uid()) and role = any (p_roles)
  )
$$;

do $$
declare t text;
begin
  foreach t in array array['branches','accounts','cashboxes','journal_entries','journal_lines','subscriptions'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy member_read on %I for select to authenticated
      using (has_role(org_id, array['owner','admin','accountant','cashier','viewer']::member_role[]))$p$, t);
  end loop;
  foreach t in array array['branches','accounts','cashboxes'] loop
    execute format($p$create policy staff_insert on %I for insert to authenticated
      with check (has_role(org_id, array['owner','admin','accountant']::member_role[]))$p$, t);
    execute format($p$create policy staff_update on %I for update to authenticated
      using (has_role(org_id, array['owner','admin','accountant']::member_role[]))
      with check (has_role(org_id, array['owner','admin','accountant']::member_role[]))$p$, t);
  end loop;
end $$;

alter table organizations enable row level security;
create policy member_read on organizations for select to authenticated
  using (has_role(id, array['owner','admin','accountant','cashier','viewer']::member_role[]));
alter table memberships enable row level security;
create policy own_or_admin_read on memberships for select to authenticated
  using (user_id = (select auth.uid()) or has_role(org_id, array['owner','admin']::member_role[]));
alter table audit_logs enable row level security;
create policy admin_read on audit_logs for select to authenticated
  using (has_role(org_id, array['owner','admin']::member_role[]));
alter table currencies enable row level security;
create policy read_all on currencies for select to authenticated using (true);
alter table plans enable row level security;
create policy read_all on plans for select to authenticated using (true);
alter table activation_codes enable row level security; -- no policies: unreachable by clients

-- The ledger and audit log can only change through the functions below.
revoke insert, update, delete on journal_entries, journal_lines, audit_logs, subscriptions,
  activation_codes, organizations, memberships from authenticated, anon;

-- Trial balance respects the caller's RLS.
create view trial_balance with (security_invoker = true) as
  select org_id, account_id, currency, sum(debit) as debit, sum(credit) as credit
  from journal_lines group by org_id, account_id, currency;

-- Atomic operations ----------------------------------------------------------
create function create_organization(p_name text, p_base_currency text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into organizations(name, base_currency) values (p_name, p_base_currency) returning id into v_org;
  insert into memberships(org_id, user_id, role) values (v_org, auth.uid(), 'owner');
  insert into subscriptions(org_id, plan_code) values (v_org, 'free');
  insert into audit_logs(org_id, actor, action, entity, entity_id)
    values (v_org, auth.uid(), 'create', 'organization', v_org);
  return v_org;
end $$;

-- p_lines: [{account_id, currency, debit, credit}] with amounts as STRINGS
-- (JSON numbers lose precision past 2^53).
create function post_journal_entry(
  p_org uuid, p_branch uuid, p_date date, p_memo text, p_key text, p_lines jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not has_role(p_org, array['owner','admin','accountant','cashier']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(p_key, '') = '' then raise exception 'idempotency key required'; end if;
  insert into journal_entries(org_id, branch_id, entry_date, memo, idempotency_key, created_by)
    values (p_org, p_branch, p_date, p_memo, p_key, auth.uid())
    on conflict (org_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then  -- retry of an already-posted operation: return the original
    select id into v_id from journal_entries where org_id = p_org and idempotency_key = p_key;
    return v_id;
  end if;
  insert into journal_lines(entry_id, org_id, account_id, currency, debit, credit)
    select v_id, p_org, l.account_id, l.currency, coalesce(l.debit, 0), coalesce(l.credit, 0)
    from jsonb_to_recordset(p_lines) as l(account_id uuid, currency text, debit bigint, credit bigint);
  insert into audit_logs(org_id, actor, action, entity, entity_id)
    values (p_org, auth.uid(), 'post', 'journal_entry', v_id);
  return v_id;
end $$;

create function reverse_journal_entry(p_entry uuid, p_key text, p_memo text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare e journal_entries; v_id uuid;
begin
  select * into e from journal_entries where id = p_entry;
  if not found then raise exception 'entry not found'; end if;
  if not has_role(e.org_id, array['owner','admin','accountant']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into journal_entries(org_id, branch_id, entry_date, memo, idempotency_key, reverses_entry_id, created_by)
    values (e.org_id, e.branch_id, current_date, coalesce(p_memo, 'Reversal of ' || e.id), p_key, e.id, auth.uid())
    on conflict (org_id, idempotency_key) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from journal_entries where org_id = e.org_id and idempotency_key = p_key;
    return v_id;
  end if;
  insert into journal_lines(entry_id, org_id, account_id, currency, debit, credit)
    select v_id, org_id, account_id, currency, credit, debit from journal_lines where entry_id = e.id;
  insert into audit_logs(org_id, actor, action, entity, entity_id)
    values (e.org_id, auth.uid(), 'reverse', 'journal_entry', e.id);
  return v_id;  -- a second reversal of the same entry violates unique(reverses_entry_id)
end $$;

create function redeem_activation_code(p_org uuid, p_code text) returns timestamptz
language plpgsql security definer set search_path = public, extensions as $$
declare v_plan text; v_months int; v_end timestamptz;
begin
  if not has_role(p_org, array['owner','admin']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update activation_codes set redeemed_org = p_org, redeemed_at = now()
    where code_hash = digest(convert_to(upper(trim(p_code)), 'UTF8'), 'sha256') and redeemed_at is null
    returning plan_code, months into v_plan, v_months;
  if v_plan is null then raise exception 'invalid or already used code'; end if;
  update subscriptions
    set plan_code = v_plan,
        period_end = greatest(coalesce(period_end, now()), now()) + make_interval(months => v_months)
    where org_id = p_org returning period_end into v_end;
  insert into audit_logs(org_id, actor, action, entity, data)
    values (p_org, auth.uid(), 'redeem', 'activation_code', jsonb_build_object('plan', v_plan, 'months', v_months));
  return v_end;
end $$;

revoke all on function create_organization(text, text), post_journal_entry(uuid, uuid, date, text, text, jsonb),
  reverse_journal_entry(uuid, text, text), redeem_activation_code(uuid, text) from public, anon;
grant execute on function create_organization(text, text), post_journal_entry(uuid, uuid, date, text, text, jsonb),
  reverse_journal_entry(uuid, text, text), redeem_activation_code(uuid, text) to authenticated;
