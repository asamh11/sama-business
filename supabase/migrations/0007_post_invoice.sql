-- 0007_post_invoice: ترحيل فاتورة بيع إلى قيد محاسبي + صرف مخزون في معاملة واحدة.
-- لم يُجرَّب على PostgreSQL هنا. الاختبار المرافق: supabase/tests/database/002_invoicing.test.sql
-- شغّله (supabase test db) على نسخة تجريبية ولا تستخدم الدالة على بيانات حقيقية قبل نجاحه.
-- الحسابات: دائن مبيعات، دائن ضريبة (إن وُجدت)، مدين ذمم/نقد، وعند المخزون: مدين تكلفة بضاعة، دائن مخزون.
create table org_settings (
  org_id uuid primary key references organizations(id),
  receivable_account_id uuid,
  sales_account_id uuid,
  tax_account_id uuid,
  inventory_account_id uuid,
  cogs_account_id uuid,
  foreign key (receivable_account_id, org_id) references accounts(id, org_id),
  foreign key (sales_account_id, org_id) references accounts(id, org_id),
  foreign key (tax_account_id, org_id) references accounts(id, org_id),
  foreign key (inventory_account_id, org_id) references accounts(id, org_id),
  foreign key (cogs_account_id, org_id) references accounts(id, org_id)
);
alter table org_settings enable row level security;
create policy org_settings_read on org_settings for select to authenticated
  using (has_role(org_id, array['owner','admin','accountant','cashier','viewer']::member_role[]));
create policy org_settings_write on org_settings for all to authenticated
  using (has_role(org_id, array['owner','admin']::member_role[]))
  with check (has_role(org_id, array['owner','admin']::member_role[]));
revoke all on org_settings from anon;
grant select, insert, update on org_settings to authenticated;

create function post_sales_invoice(p_invoice uuid, p_key text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_inv invoices%rowtype; v_set org_settings%rowtype;
  v_taxable bigint; v_tax bigint; v_cogs bigint; v_total bigint;
  v_count int; v_lines jsonb; v_entry uuid; r record;
begin
  select * into v_inv from invoices where id = p_invoice for update;
  -- "غير موجود" و"ممنوع" برسالة واحدة كي لا يُكشف وجود فواتير شركات أخرى.
  if not found or not has_role(v_inv.org_id, array['owner','admin','accountant','cashier']::member_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_inv.status = 'posted' and v_inv.journal_entry_id is not null then
    return v_inv.journal_entry_id;  -- إعادة محاولة آمنة
  end if;
  if v_inv.kind <> 'sales' then
    raise exception 'not a sales invoice' using errcode = '22023';
  end if;
  if v_inv.status <> 'draft' then
    raise exception 'invoice is not a draft' using errcode = '55000';
  end if;

  select * into v_set from org_settings where org_id = v_inv.org_id;
  if not found or v_set.receivable_account_id is null or v_set.sales_account_id is null then
    raise exception 'sales accounts are not configured' using errcode = '22023';
  end if;

  -- أقفل صفوف المنتجات بترتيب ثابت لمنع سباق صرف المخزون.
  perform 1 from products p
    where p.org_id = v_inv.org_id
      and p.id in (select product_id from invoice_lines where invoice_id = p_invoice)
    order by p.id for update;

  for r in
    select il.product_id, sum(il.qty_milli) as q, p.track_stock,
           coalesce((select sum(sm.qty_milli) from stock_movements sm
                     where sm.org_id = il.org_id and sm.product_id = il.product_id), 0) as onhand
    from invoice_lines il
    join products p on p.id = il.product_id and p.org_id = il.org_id
    where il.invoice_id = p_invoice
    group by il.product_id, il.org_id, p.track_stock
  loop
    if r.track_stock and r.q > r.onhand then
      raise exception 'insufficient stock' using errcode = '23514';
    end if;
  end loop;

  -- نفس تقريب invoice.ts: نصف بعيداً عن الصفر (round على numeric).
  with l as (
    select il.qty_milli, il.discount_bp, il.tax_bp, p.track_stock, p.cost_minor,
           round(il.qty_milli::numeric * il.unit_minor / 1000) as net
    from invoice_lines il
    join products p on p.id = il.product_id and p.org_id = il.org_id
    where il.invoice_id = p_invoice
  ), m as (
    select *, net - round(net * discount_bp / 10000.0) as taxable from l
  )
  select count(*), coalesce(sum(taxable), 0)::bigint,
         coalesce(sum(round(taxable * tax_bp / 10000.0)), 0)::bigint,
         coalesce(sum(case when track_stock then round(qty_milli::numeric * cost_minor / 1000) else 0 end), 0)::bigint
  into v_count, v_taxable, v_tax, v_cogs from m;

  if v_count = 0 then raise exception 'invoice has no lines' using errcode = '22023'; end if;
  v_total := v_taxable + v_tax;
  if v_total <= 0 then raise exception 'invoice total must be positive' using errcode = '22023'; end if;

  v_lines := jsonb_build_array(jsonb_build_object('account_id', v_set.receivable_account_id,
    'currency', v_inv.currency, 'debit', v_total, 'credit', 0));
  if v_taxable > 0 then
    v_lines := v_lines || jsonb_build_object('account_id', v_set.sales_account_id,
      'currency', v_inv.currency, 'debit', 0, 'credit', v_taxable);
  end if;
  if v_tax > 0 then
    if v_set.tax_account_id is null then
      raise exception 'tax account is not configured' using errcode = '22023';
    end if;
    v_lines := v_lines || jsonb_build_object('account_id', v_set.tax_account_id,
      'currency', v_inv.currency, 'debit', 0, 'credit', v_tax);
  end if;
  if v_cogs > 0 then
    if v_set.cogs_account_id is null or v_set.inventory_account_id is null then
      raise exception 'inventory accounts are not configured' using errcode = '22023';
    end if;
    v_lines := v_lines
      || jsonb_build_object('account_id', v_set.cogs_account_id, 'currency', v_inv.currency, 'debit', v_cogs, 'credit', 0)
      || jsonb_build_object('account_id', v_set.inventory_account_id, 'currency', v_inv.currency, 'debit', 0, 'credit', v_cogs);
  end if;

  v_entry := post_journal_entry(v_inv.org_id, v_inv.branch_id, v_inv.issue_date,
                                'Sales invoice ' || v_inv.number, p_key, v_lines);

  insert into stock_movements(org_id, product_id, branch_id, qty_milli, unit_cost_minor, invoice_id, created_by)
    select il.org_id, il.product_id, v_inv.branch_id, -sum(il.qty_milli), p.cost_minor, p_invoice, auth.uid()
    from invoice_lines il
    join products p on p.id = il.product_id and p.org_id = il.org_id
    where il.invoice_id = p_invoice and p.track_stock
    group by il.org_id, il.product_id, p.cost_minor;

  update invoices set status = 'posted', total_minor = v_total, journal_entry_id = v_entry
    where id = p_invoice;
  insert into audit_logs(org_id, actor, action, entity, entity_id, data)
    values (v_inv.org_id, auth.uid(), 'post', 'invoice', p_invoice,
            jsonb_build_object('number', v_inv.number, 'total', v_total, 'entry', v_entry));
  return v_entry;
end $$;

revoke all on function post_sales_invoice(uuid, text) from public, anon;
grant execute on function post_sales_invoice(uuid, text) to authenticated;
