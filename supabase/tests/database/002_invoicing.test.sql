-- pgTAP: ترحيل فاتورة البيع (قيد متوازن + مخزون + صلاحيات + عزل الشركات).
-- التشغيل: supabase test db   (كل شيء يُتراجع عنه في النهاية)
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function public.test_as(u uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
end $$;

-- أساسات: شركة A (owner, viewer) وشركة B (owner)
insert into auth.users (id, email) values
  ('c0000000-0000-0000-0000-000000000001', 'owner-a@test.local'),
  ('c0000000-0000-0000-0000-000000000003', 'viewer-a@test.local'),
  ('c0000000-0000-0000-0000-000000000004', 'owner-b@test.local');
insert into organizations (id, name, base_currency) values
  ('a0000000-0000-0000-0000-000000000001', 'Org A', 'USD'),
  ('b0000000-0000-0000-0000-000000000001', 'Org B', 'USD');
insert into memberships (org_id, user_id, role) values
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'owner'),
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003', 'viewer'),
  ('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000004', 'owner');
insert into subscriptions (org_id, plan_code) values
  ('a0000000-0000-0000-0000-000000000001', 'free'), ('b0000000-0000-0000-0000-000000000001', 'free');
insert into accounts (id, org_id, code, name, type) values
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', '1100', 'Receivable', 'asset'),
  ('d0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', '4000', 'Sales', 'revenue'),
  ('d0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', '2200', 'Tax', 'liability'),
  ('d0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', '1300', 'Inventory', 'asset'),
  ('d0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', '5000', 'COGS', 'expense');
insert into org_settings values ('a0000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000004',
  'd0000000-0000-0000-0000-000000000005');
insert into products (id, org_id, sku, name, currency, price_minor, cost_minor, tax_bp) values
  ('f0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'P1', 'Item', 'USD', 1000, 400, 500);
insert into stock_movements (org_id, product_id, qty_milli, unit_cost_minor, created_by) values
  ('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 10000, 400, 'c0000000-0000-0000-0000-000000000001');
-- INV-1: 2 وحدات x 10.00 = 20.00، خصم 10% = 2.00، خاضع 18.00، ضريبة 5% = 0.90، إجمالي 18.90، تكلفة 8.00
-- INV-2: 9 وحدات (المتاح بعد INV-1 هو 8): يجب أن تُرفض
insert into invoices (id, org_id, kind, number, currency, issue_date, created_by) values
  ('1a000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'sales', 'INV-1', 'USD', current_date, 'c0000000-0000-0000-0000-000000000001'),
  ('1a000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'sales', 'INV-2', 'USD', current_date, 'c0000000-0000-0000-0000-000000000001');
insert into invoice_lines (invoice_id, org_id, product_id, qty_milli, unit_minor, discount_bp, tax_bp) values
  ('1a000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 2000, 1000, 1000, 500),
  ('1a000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 9000, 1000, 0, 0);

-- الصلاحيات والعزل
select public.test_as('c0000000-0000-0000-0000-000000000003');
select throws_ok($$select public.post_sales_invoice('1a000000-0000-0000-0000-000000000001', 'k-v')$$, '42501', null, 'viewer cannot post an invoice');
select public.test_as('c0000000-0000-0000-0000-000000000004');
select throws_ok($$select public.post_sales_invoice('1a000000-0000-0000-0000-000000000001', 'k-b')$$, '42501', null, 'another org owner cannot post it');

-- الترحيل الناجح
select public.test_as('c0000000-0000-0000-0000-000000000001');
select isnt(public.post_sales_invoice('1a000000-0000-0000-0000-000000000001', 'k-inv1'), null, 'owner posts the invoice');
select is((select status from invoices where number = 'INV-1'), 'posted', 'invoice is marked posted');
select is((select total_minor from invoices where number = 'INV-1')::int, 1890, 'invoice total is 18.90');
select is((select sum(debit) from journal_lines where entry_id = (select journal_entry_id from invoices where number = 'INV-1'))::int, 2690, 'debits = 18.90 + 8.00 cogs');
select is((select sum(credit) from journal_lines where entry_id = (select journal_entry_id from invoices where number = 'INV-1'))::int, 2690, 'credits equal debits');
select is((select qty_milli from v_stock_on_hand where product_id = 'f0000000-0000-0000-0000-000000000001'), '8000', 'stock reduced from 10 to 8');
select is(public.post_sales_invoice('1a000000-0000-0000-0000-000000000001', 'k-inv1'),
  (select journal_entry_id from invoices where number = 'INV-1'), 'retry returns the same entry, no double posting');
select is((select count(*) from journal_entries where memo = 'Sales invoice INV-1')::int, 1, 'only one entry exists');

-- مخزون غير كافٍ
select throws_ok($$select public.post_sales_invoice('1a000000-0000-0000-0000-000000000002', 'k-inv2')$$, '23514', null, 'insufficient stock is rejected');
select is((select status from invoices where number = 'INV-2'), 'draft', 'rejected invoice stays a draft');

select * from finish();
rollback;
