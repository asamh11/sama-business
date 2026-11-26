-- pgTAP: ledger integrity, idempotency, reversal, tenant isolation, permissions.
-- Run: supabase test db   (everything is rolled back at the end)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- helpers (rolled back with the transaction) -----------------------------------
create function public.test_as(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
end $$;
create function public.test_as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
end $$;
create function public.test_lines(
  p_amount text default '10000',
  p_cash uuid default 'd0000000-0000-0000-0000-000000000001',
  p_rev uuid default 'd0000000-0000-0000-0000-000000000002',
  p_cur text default 'USD'
) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('account_id', p_cash, 'currency', p_cur, 'debit', p_amount, 'credit', '0'),
    jsonb_build_object('account_id', p_rev,  'currency', p_cur, 'debit', '0', 'credit', p_amount))
$$;

-- fixtures (as superuser) --------------------------------------------------------
-- orgs: A=a000..01  B=b000..01   users: ownerA=c..01 cashierA=c..02 viewerA=c..03 ownerB=c..04 outsider=c..05
insert into auth.users (id, email) values
  ('c0000000-0000-0000-0000-000000000001', 'owner-a@test.local'),
  ('c0000000-0000-0000-0000-000000000002', 'cashier-a@test.local'),
  ('c0000000-0000-0000-0000-000000000003', 'viewer-a@test.local'),
  ('c0000000-0000-0000-0000-000000000004', 'owner-b@test.local'),
  ('c0000000-0000-0000-0000-000000000005', 'outsider@test.local'),
  ('c0000000-0000-0000-0000-000000000006', 'accountant-a@test.local'),
  ('c0000000-0000-0000-0000-000000000007', 'admin-a@test.local');
insert into organizations (id, name, base_currency) values
  ('a0000000-0000-0000-0000-000000000001', 'Org A', 'USD'),
  ('b0000000-0000-0000-0000-000000000001', 'Org B', 'USD');
insert into memberships (org_id, user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'owner'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 'cashier'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003', 'viewer'),
  ('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000004', 'owner'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000006', 'accountant'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000007', 'admin');
insert into branches (id, org_id, name) values ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Main');
insert into subscriptions (org_id, plan_code) values
  ('a0000000-0000-0000-0000-000000000001', 'free'), ('b0000000-0000-0000-0000-000000000001', 'free');
insert into accounts (id, org_id, code, name, type) values
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '1000', 'Cash', 'asset'),
  ('d0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '4000', 'Revenue', 'revenue'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', '1000', 'Cash', 'asset');
insert into activation_codes (code_hash, plan_code, months)
  values (extensions.digest(convert_to('TEST-CODE-0001', 'UTF8'), 'sha256'), 'shop', 1),
         (extensions.digest(convert_to('TEST-CODE-0002', 'UTF8'), 'sha256'), 'mall', 1);

select is((select count(*) from pg_tables where schemaname = 'public' and not rowsecurity)::int, 0,
  'RLS is enabled on every public table');

-- posting: validation --------------------------------------------------------------
select public.test_as('c0000000-0000-0000-0000-000000000001');
select isnt(public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'sale', 'k1', public.test_lines()),
  null, 'owner posts a balanced entry');
select is(public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'sale', 'k1', public.test_lines()),
  (select id from journal_entries where idempotency_key = 'k1'), 'same key + same request returns the original entry');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'sale', 'k1', public.test_lines('999'))$$,
  '23505', null, 'same key with a different request is rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'e1', '[]'::jsonb)$$,
  '22023', null, 'empty lines rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'e2', null)$$,
  '22023', null, 'null lines rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'e3', jsonb_build_array(public.test_lines()->0))$$,
  '22023', null, 'single line rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'e4',
  jsonb_build_array(public.test_lines('100')->0, (public.test_lines('90')->1)))$$,
  '22023', null, 'unbalanced entry rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'e5',
  jsonb_build_array(jsonb_build_object('account_id','d0000000-0000-0000-0000-000000000001','currency','USD','debit','100','credit','100'),
                    jsonb_build_object('account_id','d0000000-0000-0000-0000-000000000002','currency','USD','debit','0','credit','0')))$$,
  '22023', null, 'line with both sides or neither side rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'e6', public.test_lines('100', 'd0000000-0000-0000-0000-000000000003'))$$,
  '23503', null, 'account of another organization rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'e7', public.test_lines(p_amount => '100', p_cur => 'ZZZ'))$$,
  '23503', null, 'unknown currency rejected');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', null, public.test_lines())$$,
  '22023', null, 'missing idempotency key rejected');

-- permissions -----------------------------------------------------------------------
select public.test_as('c0000000-0000-0000-0000-000000000002');
select isnt(public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'sale 2', 'k2', public.test_lines('500')),
  null, 'cashier can post');
select throws_ok($$select public.reverse_journal_entry((select id from journal_entries where idempotency_key = 'k2'), 'rx')$$,
  '42501', null, 'cashier cannot reverse');
select public.test_as('c0000000-0000-0000-0000-000000000003');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'v1', public.test_lines())$$,
  '42501', null, 'viewer cannot post');
select throws_ok($$insert into accounts(org_id, code, name, type) values ('a0000000-0000-0000-0000-000000000001', '9', 'x', 'asset')$$,
  '42501', null, 'viewer cannot create accounts');
select public.test_as('c0000000-0000-0000-0000-000000000005');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'o1', public.test_lines())$$,
  '42501', null, 'non-member cannot post');
select public.test_as_anon();
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'n1', public.test_lines())$$,
  '42501', null, 'anonymous cannot post');

-- direct writes are closed ------------------------------------------------------------
select public.test_as('c0000000-0000-0000-0000-000000000001');
select throws_ok($$insert into journal_entries(org_id, entry_date, idempotency_key, created_by) values ('a0000000-0000-0000-0000-000000000001', current_date, 'd1', 'c0000000-0000-0000-0000-000000000001')$$,
  '42501', null, 'no direct insert into journal_entries');
select throws_ok($$delete from journal_lines$$, '42501', null, 'no direct delete on journal_lines');
select throws_ok($$insert into audit_logs(org_id, action, entity) values ('a0000000-0000-0000-0000-000000000001', 'x', 'y')$$,
  '42501', null, 'no direct insert into audit_logs');
select throws_ok($$update subscriptions set plan_code = 'mall'$$, '42501', null, 'no direct plan change');

-- tenant isolation ---------------------------------------------------------------------
select public.test_as('c0000000-0000-0000-0000-000000000004');
select is((select count(*) from journal_entries)::int, 0, 'org B sees none of org A entries');
select is((select count(*) from accounts where org_id = 'a0000000-0000-0000-0000-000000000001')::int, 0, 'org B sees none of org A accounts');
select is((select count(*) from organizations)::int, 1, 'org B sees only its own organization');
select is((select count(*) from memberships where org_id = 'a0000000-0000-0000-0000-000000000001')::int, 0, 'org B cannot read org A memberships');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'b1', public.test_lines())$$,
  '42501', null, 'org B cannot post into org A');
select throws_ok($$insert into accounts(org_id, code, name, type) values ('a0000000-0000-0000-0000-000000000001', '9', 'x', 'asset')$$,
  '42501', null, 'org B cannot create accounts in org A');

-- reversal ---------------------------------------------------------------------------------
select public.test_as('c0000000-0000-0000-0000-000000000001');
select isnt(public.reverse_journal_entry((select id from journal_entries where idempotency_key = 'k1'), 'r1'), null, 'owner reverses an entry');
select is(public.reverse_journal_entry((select id from journal_entries where idempotency_key = 'k1'), 'r1'),
  (select id from journal_entries where idempotency_key = 'r1'), 'reversal retry with the same key returns the same reversal');
select throws_ok($$select public.reverse_journal_entry((select id from journal_entries where idempotency_key = 'k1'), 'r2')$$,
  '23505', null, 'second reversal with a new key is rejected');
select results_eq(
  $$select account_id, currency, debit, credit from journal_lines where entry_id = (select id from journal_entries where idempotency_key = 'r1') order by account_id$$,
  $$select account_id, currency, credit, debit from journal_lines where entry_id = (select id from journal_entries where idempotency_key = 'k1') order by account_id$$,
  'reversal mirrors the original exactly');
select is((select reverses_entry_id from journal_entries where idempotency_key = 'r1'),
  (select id from journal_entries where idempotency_key = 'k1'), 'reversal links to the original');

-- cashboxes -----------------------------------------------------------------------------------
select throws_ok($$insert into cashboxes(org_id, name, currency, account_id) values ('a0000000-0000-0000-0000-000000000001', 'Bad', 'USD', 'd0000000-0000-0000-0000-000000000002')$$,
  '22023', null, 'cashbox on a non-asset account rejected');
select lives_ok($$insert into cashboxes(org_id, name, currency, account_id) values ('a0000000-0000-0000-0000-000000000001', 'Main USD', 'USD', 'd0000000-0000-0000-0000-000000000001')$$,
  'cashbox on an asset account accepted');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', null, current_date, 'x', 'c1', public.test_lines(p_amount => '100', p_cur => 'SYP'))$$,
  '22023', null, 'a line in another currency on a cashbox account is rejected');
select throws_ok($$update accounts set type = 'expense' where id = 'd0000000-0000-0000-0000-000000000001'$$,
  '22023', null, 'account type is locked once it has ledger lines');

-- activation codes --------------------------------------------------------------------------------
select is((select count(*) from activation_codes)::int, 0, 'clients cannot read activation codes');
select isnt(public.redeem_activation_code('a0000000-0000-0000-0000-000000000001', ' test-code-0001 '), null, 'owner redeems a valid code');
select is((select plan_code from subscriptions where org_id = 'a0000000-0000-0000-0000-000000000001'), 'shop', 'plan upgraded');
select throws_ok($$select public.redeem_activation_code('a0000000-0000-0000-0000-000000000001', 'TEST-CODE-0001')$$,
  'P0001', null, 'a code cannot be used twice');

-- organization creation ------------------------------------------------------------------------------
select public.test_as('c0000000-0000-0000-0000-000000000005');
select isnt(public.create_organization('New Co', 'USD'), null, 'signed-in user creates an organization');
select is((select role::text from memberships where user_id = 'c0000000-0000-0000-0000-000000000005'), 'owner', 'creator becomes owner');

-- accountant and admin roles ------------------------------------------------------------------------
select public.test_as('c0000000-0000-0000-0000-000000000006');
select isnt(public.post_journal_entry('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', current_date, 'x', 'ac1', public.test_lines('700')),
  null, 'accountant can post (with a branch of the same organization)');
select isnt(public.reverse_journal_entry((select id from journal_entries where idempotency_key = 'ac1'), 'ar1'), null, 'accountant can reverse');
select lives_ok($$insert into accounts(org_id, code, name, type) values ('a0000000-0000-0000-0000-000000000001', '5000', 'Rent', 'expense')$$,
  'accountant can create accounts');
select is((select count(*) from audit_logs)::int, 0, 'accountant cannot read the audit log');
select throws_ok($$select public.redeem_activation_code('a0000000-0000-0000-0000-000000000001', 'TEST-CODE-0002')$$,
  '42501', null, 'accountant cannot redeem activation codes');
select public.test_as('c0000000-0000-0000-0000-000000000007');
select ok((select count(*) from audit_logs) > 0, 'admin can read the audit log');
select isnt(public.redeem_activation_code('a0000000-0000-0000-0000-000000000001', 'TEST-CODE-0002'), null, 'admin can redeem a code');
select throws_ok($$update branches set org_id = 'b0000000-0000-0000-0000-000000000001' where id = 'e0000000-0000-0000-0000-000000000001'$$,
  '22023', null, 'a branch cannot be moved to another organization');
select throws_ok($$select public.post_journal_entry('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000099', current_date, 'x', 'br1', public.test_lines())$$,
  '23503', null, 'unknown branch rejected');

-- immutability (superuser still cannot rewrite history) ---------------------------------------------------
reset role;
select throws_ok($$update journal_lines set debit = debit$$, 'P0001', null, 'journal_lines are immutable');
select throws_ok($$delete from journal_entries$$, 'P0001', null, 'journal_entries are immutable');
select throws_ok($$update audit_logs set action = 'x'$$, 'P0001', null, 'audit_logs are immutable');

select * from finish();
rollback;
