-- 0005_platform_owner: مالك منصة واحد (أنت) غير مرئي لأي مستخدم.
-- الأمان في قاعدة البيانات: الجدول مغلق بالكامل بـ RLS دون أي سياسة،
-- ولا يُضاف مالك إلا يدوياً من SQL Editor (لا مسار تسجيل يمنح هذا الدور).
-- لم يُجرَّب على PostgreSQL هنا: شغّله على نسخة تجريبية أولاً.
create table platform_owners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table platform_owners enable row level security;
revoke all on platform_owners from public, anon, authenticated;

create function is_platform_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_owners where user_id = (select auth.uid()))
$$;

-- نظرة عامة: أعداد فقط، بلا أي مبالغ مالية للشركات (خصوصية العملاء).
create function owner_overview() returns table (
  org_id uuid, org_name text, created_at timestamptz, plan_code text,
  period_end timestamptz, members bigint, entries bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select o.id, o.name, o.created_at, s.plan_code, s.period_end,
           (select count(*) from memberships m where m.org_id = o.id),
           (select count(*) from journal_entries e where e.org_id = o.id)
    from organizations o left join subscriptions s on s.org_id = o.id
    order by o.created_at desc
    limit 500;
end $$;

-- إصدار كود تفعيل: يُعاد النص مرة واحدة فقط، ويُخزَّن hash له (نفس صيغة redeem_activation_code).
create function owner_issue_code(p_plan text, p_months int) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_code text;
begin
  if not is_platform_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_months is null or p_months not between 1 and 36 then
    raise exception 'months must be between 1 and 36';
  end if;
  v_code := upper(encode(gen_random_bytes(8), 'hex'));
  insert into activation_codes (code_hash, plan_code, months, agent_id)
    values (digest(convert_to(v_code, 'UTF8'), 'sha256'), p_plan, p_months, auth.uid());
  return v_code;
end $$;

revoke all on function is_platform_owner(), owner_overview(), owner_issue_code(text, int) from public, anon;
grant execute on function is_platform_owner(), owner_overview(), owner_issue_code(text, int) to authenticated;
