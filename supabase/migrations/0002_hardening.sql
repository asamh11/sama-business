-- Sama Business 0002: hardening of posting, reversal, idempotency, cashboxes.
-- Additive on top of 0001. Error codes: 42501 forbidden, 22023 invalid input,
-- 23505 idempotency/duplicate conflict.

-- Input hygiene ------------------------------------------------------------
alter table organizations add constraint organizations_name_ok check (length(btrim(name)) between 1 and 200);
alter table branches add constraint branches_name_ok check (length(btrim(name)) between 1 and 200);
alter table accounts add constraint accounts_name_ok check (length(btrim(name)) between 1 and 200);
alter table accounts add constraint accounts_code_ok check (length(btrim(code)) between 1 and 50);
alter table cashboxes add constraint cashboxes_name_ok check (length(btrim(name)) between 1 and 200);
alter table plans add constraint plans_limits_ok
  check (max_branches > 0 and max_members > 0 and ai_monthly_quota >= 0);

-- Idempotency: remember WHAT was requested, so a reused key with a different
-- request is rejected instead of silently returning an unrelated entry.
alter table journal_entries add column request_hash bytea;

-- Accounts: org is fixed; type is fixed once the account has ledger lines.
create function accounts_guard() returns trigger language plpgsql as $$
begin
  if new.org_id <> old.org_id then
    raise exception 'account organization cannot change' using errcode = '22023';
  end if;
  if new.type <> old.type and exists (select 1 from journal_lines where account_id = old.id) then
    raise exception 'account type cannot change after it has ledger lines' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger accounts_guard before update on accounts for each row execute function accounts_guard();

-- Tenant keys never move: staff of two organizations must not be able to
-- re-parent a branch or cashbox from one to the other.
create function forbid_org_change() returns trigger language plpgsql as $$
begin
  if new.org_id <> old.org_id then
    raise exception 'org_id cannot change on %', tg_table_name using errcode = '22023';
  end if;
  return new;
end $$;
create trigger branches_org_fixed before update on branches for each row execute function forbid_org_change();
create trigger cashboxes_org_fixed before update on cashboxes for each row execute function forbid_org_change();

-- Cashboxes: asset account only, one cashbox per account, single currency.
alter table cashboxes add constraint cashboxes_account_unique unique (account_id);
create function check_cashbox_account() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from accounts a where a.id = new.account_id and a.org_id = new.org_id and a.type = 'asset') then
    raise exception 'cashbox account must be an asset account of the same organization' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger cashboxes_account_check before insert or update on cashboxes
  for each row execute function check_cashbox_account();

create function check_cashbox_currency() returns trigger language plpgsql as $$
begin
  if exists (select 1 from cashboxes c where c.account_id = new.account_id and c.currency <> new.currency) then
    raise exception 'line currency differs from the cashbox currency' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger journal_lines_cashbox_currency before insert on journal_lines
  for each row execute function check_cashbox_currency();

-- Posting --------------------------------------------------------------------
create or replace function post_journal_entry(
  p_org uuid, p_branch uuid, p_date date, p_memo text, p_key text, p_lines jsonb
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid; v_old_id uuid; v_old_hash bytea; v_hash bytea; v_bad int;
begin
  if not has_role(p_org, array['owner','admin','accountant','cashier']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_key is null or length(btrim(p_key)) = 0 or length(p_key) > 200 then
    raise exception 'idempotency key must be 1-200 characters' using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'entry date required' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'an entry needs at least 2 lines' using errcode = '22023';
  end if;

  select count(*) into v_bad
  from jsonb_to_recordset(p_lines) as l(account_id uuid, currency text, debit bigint, credit bigint)
  where l.account_id is null or l.currency is null
     or coalesce(l.debit, 0) < 0 or coalesce(l.credit, 0) < 0
     or (coalesce(l.debit, 0) > 0) = (coalesce(l.credit, 0) > 0);
  if v_bad > 0 then
    raise exception 'every line needs account_id, currency and exactly one positive debit or credit'
      using errcode = '22023';
  end if;

  select count(*) into v_bad from (
    select 1
    from jsonb_to_recordset(p_lines) as l(account_id uuid, currency text, debit bigint, credit bigint)
    group by l.currency
    having sum(coalesce(l.debit, 0)) <> sum(coalesce(l.credit, 0))
  ) x;
  if v_bad > 0 then
    raise exception 'entry is not balanced per currency' using errcode = '22023';
  end if;

  -- Canonical, order-independent fingerprint of the request.
  select digest(convert_to(jsonb_build_object(
      'branch', p_branch, 'date', p_date, 'memo', p_memo,
      'lines', (
        select jsonb_agg(jsonb_build_object('a', l.account_id, 'c', l.currency,
                 'd', coalesce(l.debit, 0), 'k', coalesce(l.credit, 0))
               order by l.account_id, l.currency, coalesce(l.debit, 0), coalesce(l.credit, 0))
        from jsonb_to_recordset(p_lines) as l(account_id uuid, currency text, debit bigint, credit bigint)
      ))::text, 'UTF8'), 'sha256')
  into v_hash;

  select id, request_hash into v_old_id, v_old_hash
  from journal_entries where org_id = p_org and idempotency_key = p_key;
  if found then
    if v_old_hash is distinct from v_hash then
      raise exception 'idempotency key already used by a different request' using errcode = '23505';
    end if;
    return v_old_id;  -- genuine retry
  end if;

  insert into journal_entries(org_id, branch_id, entry_date, memo, idempotency_key, request_hash, created_by)
    values (p_org, p_branch, p_date, p_memo, p_key, v_hash, auth.uid())
    returning id into v_id;
  insert into journal_lines(entry_id, org_id, account_id, currency, debit, credit)
    select v_id, p_org, l.account_id, l.currency, coalesce(l.debit, 0), coalesce(l.credit, 0)
    from jsonb_to_recordset(p_lines) as l(account_id uuid, currency text, debit bigint, credit bigint);
  insert into audit_logs(org_id, actor, action, entity, entity_id, data)
    values (p_org, auth.uid(), 'post', 'journal_entry', v_id,
            jsonb_build_object('key', p_key, 'lines', jsonb_array_length(p_lines)));
  return v_id;
end $$;

-- Reversal: date defaults to today in UTC (document the policy per country
-- once fiscal periods exist; closed periods are not enforced yet).
drop function reverse_journal_entry(uuid, text, text);
create function reverse_journal_entry(
  p_entry uuid, p_key text, p_memo text default null, p_date date default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare e journal_entries; v_id uuid; v_old_id uuid; v_old_hash bytea; v_hash bytea;
begin
  select * into e from journal_entries where id = p_entry;
  if not found or not has_role(e.org_id, array['owner','admin','accountant']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';  -- same answer for missing and foreign entries
  end if;
  if p_key is null or length(btrim(p_key)) = 0 or length(p_key) > 200 then
    raise exception 'idempotency key must be 1-200 characters' using errcode = '22023';
  end if;
  v_hash := digest(convert_to('reverse|' || p_entry::text || '|' || coalesce(p_date::text, '') || '|' || coalesce(p_memo, ''), 'UTF8'), 'sha256');

  select id, request_hash into v_old_id, v_old_hash
  from journal_entries where org_id = e.org_id and idempotency_key = p_key;
  if found then
    if v_old_hash is distinct from v_hash then
      raise exception 'idempotency key already used by a different request' using errcode = '23505';
    end if;
    return v_old_id;
  end if;
  if exists (select 1 from journal_entries where reverses_entry_id = p_entry) then
    raise exception 'entry already reversed' using errcode = '23505';
  end if;

  insert into journal_entries(org_id, branch_id, entry_date, memo, idempotency_key, request_hash, reverses_entry_id, created_by)
    values (e.org_id, e.branch_id, coalesce(p_date, (now() at time zone 'UTC')::date),
            coalesce(p_memo, 'Reversal of ' || e.id), p_key, v_hash, e.id, auth.uid())
    returning id into v_id;
  insert into journal_lines(entry_id, org_id, account_id, currency, debit, credit)
    select v_id, org_id, account_id, currency, credit, debit from journal_lines where entry_id = e.id;
  insert into audit_logs(org_id, actor, action, entity, entity_id, data)
    values (e.org_id, auth.uid(), 'reverse', 'journal_entry', e.id, jsonb_build_object('reversal', v_id));
  return v_id;
end $$;

revoke all on function reverse_journal_entry(uuid, text, text, date) from public, anon;
grant execute on function reverse_journal_entry(uuid, text, text, date) to authenticated;
