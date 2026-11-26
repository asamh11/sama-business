-- Sama Business 0003: closed books, activation-code throttling, row-level audit,
-- member management with last-owner protection and plan member limits.
-- Error codes: 55000 invalid state (closed books / last owner), 54000 too many
-- attempts, 53400 plan limit reached, 42501 forbidden, 22023 invalid input.

-- 1. Closed books ---------------------------------------------------------------
-- Entries dated on or before books_closed_through are refused. The date only
-- moves forward; reopening needs a separate, deliberate procedure (not built).
alter table organizations add column books_closed_through date;

create function enforce_open_books() returns trigger language plpgsql as $$
declare v_closed date;
begin
  select books_closed_through into v_closed from organizations where id = new.org_id;
  if v_closed is not null and new.entry_date <= v_closed then
    raise exception 'books are closed through %', v_closed using errcode = '55000';
  end if;
  return new;
end $$;
create trigger journal_entries_open_books before insert on journal_entries
  for each row execute function enforce_open_books();

create function close_books(p_org uuid, p_through date) returns date
language plpgsql security definer set search_path = public as $$
declare v_cur date;
begin
  if not has_role(p_org, array['owner','admin']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_through is null or p_through > current_date then
    raise exception 'closing date must be today or earlier' using errcode = '22023';
  end if;
  select books_closed_through into v_cur from organizations where id = p_org for update;
  if v_cur is not null and p_through < v_cur then
    raise exception 'books cannot be reopened' using errcode = '55000';
  end if;
  update organizations set books_closed_through = p_through where id = p_org;
  insert into audit_logs(org_id, actor, action, entity, entity_id, data)
    values (p_org, auth.uid(), 'close_books', 'organization', p_org,
            jsonb_build_object('through', p_through, 'previous', v_cur));
  return p_through;
end $$;

-- 2. Activation-code throttling --------------------------------------------------
-- A wrong code is recorded and returns NULL (raising would roll the record back).
create table redeem_attempts (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id),
  user_id uuid,
  at timestamptz not null default now()
);
create index on redeem_attempts (org_id, at);
alter table redeem_attempts enable row level security;  -- no policies: unreachable by clients
revoke all on redeem_attempts from authenticated, anon;

create or replace function redeem_activation_code(p_org uuid, p_code text) returns timestamptz
language plpgsql security definer set search_path = public, extensions as $$
declare v_plan text; v_months int; v_end timestamptz;
begin
  if not has_role(p_org, array['owner','admin']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
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

-- 3. Row-level audit (before/after) for setup tables --------------------------------
create function audit_row() returns trigger language plpgsql security definer set search_path = public as $$
declare v_old jsonb;
begin
  if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
  insert into audit_logs(org_id, actor, action, entity, entity_id, data)
    values (new.org_id, auth.uid(), lower(tg_op), tg_table_name, new.id,
            jsonb_build_object('old', v_old, 'new', to_jsonb(new)));
  return null;
end $$;
create trigger accounts_audit after insert or update on accounts for each row execute function audit_row();
create trigger branches_audit after insert or update on branches for each row execute function audit_row();
create trigger cashboxes_audit after insert or update on cashboxes for each row execute function audit_row();

-- 4. Member management ----------------------------------------------------------------
create function add_member(p_org uuid, p_user uuid, p_role member_role) returns void
language plpgsql security definer set search_path = public as $$
declare v_max int;
begin
  if not has_role(p_org, array['owner','admin']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role = 'owner' and not has_role(p_org, array['owner']::member_role[]) then
    raise exception 'only an owner can add an owner' using errcode = '42501';
  end if;
  select p.max_members into v_max from subscriptions s join plans p on p.code = s.plan_code where s.org_id = p_org;
  if (select count(*) from memberships where org_id = p_org) >= coalesce(v_max, 0) then
    raise exception 'member limit of the plan reached' using errcode = '53400';
  end if;
  insert into memberships(org_id, user_id, role) values (p_org, p_user, p_role);
  insert into audit_logs(org_id, actor, action, entity, data)
    values (p_org, auth.uid(), 'add_member', 'membership', jsonb_build_object('user', p_user, 'role', p_role));
end $$;

create function set_member_role(p_org uuid, p_user uuid, p_role member_role) returns void
language plpgsql security definer set search_path = public as $$
declare v_cur member_role;
begin
  if not has_role(p_org, array['owner']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform 1 from memberships where org_id = p_org and role = 'owner' for update;  -- serialize owner changes
  select role into v_cur from memberships where org_id = p_org and user_id = p_user;
  if not found then raise exception 'member not found' using errcode = 'P0002'; end if;
  if v_cur = 'owner' and p_role <> 'owner'
     and (select count(*) from memberships where org_id = p_org and role = 'owner') <= 1 then
    raise exception 'an organization must keep at least one owner' using errcode = '55000';
  end if;
  update memberships set role = p_role where org_id = p_org and user_id = p_user;
  insert into audit_logs(org_id, actor, action, entity, data)
    values (p_org, auth.uid(), 'set_member_role', 'membership',
            jsonb_build_object('user', p_user, 'from', v_cur, 'to', p_role));
end $$;

create function remove_member(p_org uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_cur member_role;
begin
  if not has_role(p_org, array['owner','admin']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform 1 from memberships where org_id = p_org and role = 'owner' for update;
  select role into v_cur from memberships where org_id = p_org and user_id = p_user;
  if not found then raise exception 'member not found' using errcode = 'P0002'; end if;
  if v_cur = 'owner' then
    if not has_role(p_org, array['owner']::member_role[]) then
      raise exception 'only an owner can remove an owner' using errcode = '42501';
    end if;
    if (select count(*) from memberships where org_id = p_org and role = 'owner') <= 1 then
      raise exception 'an organization must keep at least one owner' using errcode = '55000';
    end if;
  end if;
  delete from memberships where org_id = p_org and user_id = p_user;
  insert into audit_logs(org_id, actor, action, entity, data)
    values (p_org, auth.uid(), 'remove_member', 'membership', jsonb_build_object('user', p_user, 'role', v_cur));
end $$;

revoke all on function close_books(uuid, date), add_member(uuid, uuid, member_role),
  set_member_role(uuid, uuid, member_role), remove_member(uuid, uuid) from public, anon;
grant execute on function close_books(uuid, date), add_member(uuid, uuid, member_role),
  set_member_role(uuid, uuid, member_role), remove_member(uuid, uuid) to authenticated;
