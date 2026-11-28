-- 0006_invoicing: المنتجات والفواتير وحركات المخزون (مسودة هيكلية).
-- لم يُجرَّب على PostgreSQL هنا. لا توجد بعد دالة ترحيل الفاتورة إلى قيد محاسبي:
-- هذه الخطوة التالية ويجب اختبارها على PostgreSQL حقيقي قبل أي استخدام فعلي.
-- الكميات بالألف (qty_milli: 1.5 وحدة = 1500). المبالغ بالوحدات الصغرى للعملة.
create table products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  sku text not null,
  name text not null,
  unit text not null default 'unit',
  currency text not null references currencies(code),
  price_minor bigint not null check (price_minor >= 0),
  cost_minor bigint not null default 0 check (cost_minor >= 0),
  tax_bp int not null default 0 check (tax_bp between 0 and 10000), -- لا نسبة افتراضية: راجع محاسبك
  track_stock boolean not null default true,
  is_active boolean not null default true,
  unique (org_id, sku),
  unique (id, org_id)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  branch_id uuid,
  kind text not null check (kind in ('sales','purchase')),
  number text not null,
  party_name text,
  currency text not null references currencies(code),
  issue_date date not null,
  due_date date,                         -- أساس تذكير سداد الدين لاحقاً
  status text not null default 'draft' check (status in ('draft','posted','cancelled')),
  total_minor bigint not null default 0 check (total_minor >= 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0 and paid_minor <= total_minor),
  verification_code text,                -- الرمز الناتج عن آلية التحقق الإلكتروني لوزارة المالية (القرار 273/2021)، يُخزَّن كما يصدر
  journal_entry_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, kind, number),
  unique (id, org_id),
  foreign key (branch_id, org_id) references branches(id, org_id),
  foreign key (journal_entry_id, org_id) references journal_entries(id, org_id)
);

create table invoice_lines (
  id bigint generated always as identity primary key,
  invoice_id uuid not null,
  org_id uuid not null,
  product_id uuid not null,
  qty_milli bigint not null check (qty_milli > 0),
  unit_minor bigint not null check (unit_minor >= 0),
  discount_bp int not null default 0 check (discount_bp between 0 and 10000),
  tax_bp int not null default 0 check (tax_bp between 0 and 10000),
  foreign key (invoice_id, org_id) references invoices(id, org_id),
  foreign key (product_id, org_id) references products(id, org_id)
);
create index on invoice_lines (invoice_id);

-- حركات المخزون: إضافة فقط (لا تعديل ولا حذف)، والرصيد = مجموع الحركات.
create table stock_movements (
  id bigint generated always as identity primary key,
  org_id uuid not null,
  product_id uuid not null,
  branch_id uuid,
  qty_milli bigint not null check (qty_milli <> 0), -- موجب إدخال، سالب صرف
  unit_cost_minor bigint not null default 0 check (unit_cost_minor >= 0),
  invoice_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (product_id, org_id) references products(id, org_id),
  foreign key (branch_id, org_id) references branches(id, org_id),
  foreign key (invoice_id, org_id) references invoices(id, org_id)
);
create index on stock_movements (org_id, product_id);

create view v_stock_on_hand with (security_invoker = true) as
  select org_id, product_id, sum(qty_milli)::text as qty_milli
  from stock_movements group by org_id, product_id;

alter table products enable row level security;
alter table invoices enable row level security;
alter table invoice_lines enable row level security;
alter table stock_movements enable row level security;

do $$ declare t text; begin
  foreach t in array array['products','invoices','invoice_lines','stock_movements'] loop
    execute format($p$create policy %I_read on %I for select to authenticated
      using (has_role(org_id, array['owner','admin','accountant','cashier','viewer']::member_role[]))$p$, t, t);
  end loop;
end $$;

create policy products_write on products for all to authenticated
  using (has_role(org_id, array['owner','admin','accountant']::member_role[]))
  with check (has_role(org_id, array['owner','admin','accountant']::member_role[]));
create policy invoices_insert on invoices for insert to authenticated
  with check (status = 'draft' and created_by = (select auth.uid())
    and has_role(org_id, array['owner','admin','accountant','cashier']::member_role[]));
create policy invoices_update_draft on invoices for update to authenticated
  using (status = 'draft' and has_role(org_id, array['owner','admin','accountant','cashier']::member_role[]))
  with check (status = 'draft');
create policy invoice_lines_write on invoice_lines for all to authenticated
  using (has_role(org_id, array['owner','admin','accountant','cashier']::member_role[])
    and exists (select 1 from invoices i where i.id = invoice_id and i.status = 'draft'))
  with check (has_role(org_id, array['owner','admin','accountant','cashier']::member_role[])
    and exists (select 1 from invoices i where i.id = invoice_id and i.status = 'draft'));
-- stock_movements: لا سياسة كتابة عمداً؛ تُكتب من دالة ترحيل الفاتورة (الخطوة التالية) فقط.

revoke all on products, invoices, invoice_lines, stock_movements, v_stock_on_hand from anon;
grant select, insert, update, delete on products, invoice_lines to authenticated;
grant select, insert, update on invoices to authenticated;
grant select on stock_movements, v_stock_on_hand to authenticated;

create trigger stock_movements_no_change
  before update or delete on stock_movements
  for each row execute function forbid_change();
