grant usage on schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select on public.currencies, public.organizations, public.memberships, public.journal_entries, public.journal_lines, public.audit_logs, public.stock_movements, public.v_account_balances, public.v_stock_on_hand to authenticated;
grant select, insert, update on public.branches, public.accounts, public.cashboxes, public.org_settings, public.invoices to authenticated;
grant select, insert, update, delete on public.products, public.invoice_lines to authenticated;
