-- 0004_scale: أرصدة مجمّعة في الخادم بدل تحميل كل سطور القيود إلى المتصفح.
-- security_invoker: العرض يخضع لسياسات RLS الخاصة بالمستخدم نفسه (لا يتجاوزها).
-- المجاميع نصوص (::text) كي لا تفقد دقتها فوق 2^53 عند تحويلها إلى JSON.
-- لم يُجرَّب على PostgreSQL هنا: شغّله على نسخة تجريبية أولاً.
create or replace view v_account_balances
  with (security_invoker = true) as
select org_id, account_id, currency,
       sum(debit)::text  as debit,
       sum(credit)::text as credit
from journal_lines
group by org_id, account_id, currency;

revoke all on v_account_balances from anon;
grant select on v_account_balances to authenticated;
