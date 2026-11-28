-- Sama Business 0004: close a concurrency gap left by 0002.
-- Additive on top of 0003. Does not touch 0001-0003 (already applied elsewhere).
--
-- Bug: 0002's post_journal_entry / reverse_journal_entry check
-- "does this idempotency key already exist?" with a plain SELECT, then INSERT.
-- Two callers racing with the IDENTICAL key (e.g. a client retry firing while
-- the first request is still in flight) can both pass the SELECT before
-- either INSERTs. The loser then hits a raw unique_violation on
-- (org_id, idempotency_key) instead of gracefully getting back the winner's
-- entry id — turning a legitimate retry into a hard error for the caller.
-- 0001's original version avoided this with INSERT ... ON CONFLICT DO NOTHING;
-- 0002 dropped that when it added the request-hash mismatch check. This
-- restores ON CONFLICT while keeping the hash check for genuinely different
-- requests reusing the same key.
--
-- Sequential pgTAP cases (same-key retry, reversal-retry, mismatched-key
-- rejection) behave identically to 0002; only true concurrent calls differ.
-- This still can't be exercised by a single-session pgTAP script, so treat it
-- as reviewed-not-executed, same as the rest of this file.

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

  select digest(convert_to(jsonb_build_object(
      'branch', p_branch, 'date', p_date, 'memo', p_memo,
      'lines', (
        select jsonb_agg(jsonb_build_object('a', l.account_id, 'c', l.currency,
                 'd', coalesce(l.debit, 0), 'k', coalesce(l.credit, 0))
               order by l.account_id, l.currency, coalesce(l.debit, 0), coalesce(l.credit, 0))
        from jsonb_to_recordset(p_lines) as l(account_id uuid, currency text, debit bigint, credit bigint)
      ))::text, 'UTF8'), 'sha256')
  into v_hash;

  -- Race-safe: insert optimistically. ON CONFLICT means a concurrent caller
  -- using the same key never gets a raw constraint error for a valid retry.
  insert into journal_entries(org_id, branch_id, entry_date, memo, idempotency_key, request_hash, created_by)
    values (p_org, p_branch, p_date, p_memo, p_key, v_hash, auth.uid())
    on conflict (org_id, idempotency_key) do nothing
    returning id into v_id;

  if v_id is null then
    select id, request_hash into v_old_id, v_old_hash
    from journal_entries where org_id = p_org and idempotency_key = p_key;
    if v_old_hash is distinct from v_hash then
      raise exception 'idempotency key already used by a different request' using errcode = '23505';
    end if;
    return v_old_id;  -- genuine retry, including a concurrent one
  end if;

  insert into journal_lines(entry_id, org_id, account_id, currency, debit, credit)
    select v_id, p_org, l.account_id, l.currency, coalesce(l.debit, 0), coalesce(l.credit, 0)
    from jsonb_to_recordset(p_lines) as l(account_id uuid, currency text, debit bigint, credit bigint);
  insert into audit_logs(org_id, actor, action, entity, entity_id, data)
    values (p_org, auth.uid(), 'post', 'journal_entry', v_id,
            jsonb_build_object('key', p_key, 'lines', jsonb_array_length(p_lines)));
  return v_id;
end $$;

create or replace function reverse_journal_entry(
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
    return v_old_id;  -- genuine retry
  end if;
  if exists (select 1 from journal_entries where reverses_entry_id = p_entry) then
    raise exception 'entry already reversed' using errcode = '23505';
  end if;

  -- Race-safe for two callers retrying the same new key at once (mirrors
  -- post_journal_entry above). Two DIFFERENT keys reversing the same entry at
  -- the exact same instant can still surface as a raw unique_violation on
  -- reverses_entry_id rather than the friendly message above; the result is
  -- still correct (one wins, one is rejected) — only the error text differs.
  -- Closing that last sliver needs an advisory lock on p_entry; not done here.
  insert into journal_entries(org_id, branch_id, entry_date, memo, idempotency_key, request_hash, reverses_entry_id, created_by)
    values (e.org_id, e.branch_id, coalesce(p_date, (now() at time zone 'UTC')::date),
            coalesce(p_memo, 'Reversal of ' || e.id), p_key, v_hash, e.id, auth.uid())
    on conflict (org_id, idempotency_key) do nothing
    returning id into v_id;

  if v_id is null then
    select id, request_hash into v_old_id, v_old_hash
    from journal_entries where org_id = e.org_id and idempotency_key = p_key;
    if v_old_hash is distinct from v_hash then
      raise exception 'idempotency key already used by a different request' using errcode = '23505';
    end if;
    return v_old_id;
  end if;

  insert into journal_lines(entry_id, org_id, account_id, currency, debit, credit)
    select v_id, org_id, account_id, currency, credit, debit from journal_lines where entry_id = e.id;
  insert into audit_logs(org_id, actor, action, entity, entity_id, data)
    values (e.org_id, auth.uid(), 'reverse', 'journal_entry', e.id, jsonb_build_object('reversal', v_id));
  return v_id;
end $$;

-- Two lower-severity, same-shaped race windows: soft business limits (not
-- money-correctness) where a burst of concurrent calls for the same org could
-- squeeze through slightly over the intended cap. An advisory lock scoped to
-- the org serializes just the check for that org, without locking any table.
create or replace function redeem_activation_code(p_org uuid, p_code text) returns timestamptz
language plpgsql security definer set search_path = public, extensions as $$
declare v_plan text; v_months int; v_end timestamptz;
begin
  if not has_role(p_org, array['owner','admin']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('redeem:' || p_org::text, 0));
  if (select count(*) from redeem_attempts
      where org_id = p_org and at > now() - interval '1 hour') >= 5 then
    raise exception 'too many failed attempts, try again later' using errcode = '54000';
  end if;
  update activation_codes set redeemed_org = p_org, redeemed_at = now()
    where code_hash = digest(convert_to(upper(trim(p_code)), 'UTF8'), 'sha256') and redeemed_at is null
    returning plan_code, months into v_plan, v_months;
  if v_plan is null then
    insert into redeem_attempts(org_id, user_id) values (p_org, auth.uid());
    return null;
  end if;
  update subscriptions
    set plan_code = v_plan,
        period_end = greatest(coalesce(period_end, now()), now()) + make_interval(months => v_months)
    where org_id = p_org returning period_end into v_end;
  insert into audit_logs(org_id, actor, action, entity, data)
    values (p_org, auth.uid(), 'redeem', 'activation_code', jsonb_build_object('plan', v_plan, 'months', v_months));
  return v_end;
end $$;

create or replace function add_member(p_org uuid, p_user uuid, p_role member_role) returns void
language plpgsql security definer set search_path = public as $$
declare v_max int;
begin
  if not has_role(p_org, array['owner','admin']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role = 'owner' and not has_role(p_org, array['owner']::member_role[]) then
    raise exception 'only an owner can add an owner' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('members:' || p_org::text, 0));
  select p.max_members into v_max from subscriptions s join plans p on p.code = s.plan_code where s.org_id = p_org;
  if (select count(*) from memberships where org_id = p_org) >= coalesce(v_max, 0) then
    raise exception 'member limit of the plan reached' using errcode = '53400';
  end if;
  insert into memberships(org_id, user_id, role) values (p_org, p_user, p_role);
  insert into audit_logs(org_id, actor, action, entity, data)
    values (p_org, auth.uid(), 'add_member', 'membership', jsonb_build_object('user', p_user, 'role', p_role));
end $$;
