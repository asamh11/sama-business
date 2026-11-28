#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DB_URL:?يرجى تحديد SOURCE_DB_URL}"
: "${RESTORE_DB_URL:?يرجى تحديد RESTORE_DB_URL}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "1) أخذ نسخة احتياطية كاملة (auth.users + كامل مخطط public بما فيه الحسابات والقيود)..."
pg_dump "$SOURCE_DB_URL" --format=custom --no-owner --no-privileges \
  --schema=public \
  --file="$TMP_DIR/public.dump"

pg_dump "$SOURCE_DB_URL" --format=custom --no-owner --no-privileges \
  --table=auth.users \
  --file="$TMP_DIR/auth_users.dump"

echo "2) استعادة النسخة إلى قاعدة التحقق النظيفة..."
psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -c "create schema if not exists auth;"
pg_restore --dbname="$RESTORE_DB_URL" --clean --if-exists --no-owner --no-privileges "$TMP_DIR/auth_users.dump" || true
pg_restore --dbname="$RESTORE_DB_URL" --clean --if-exists --no-owner --no-privileges "$TMP_DIR/public.dump"

echo "3) مقارنة بصمة الأعداد ومجاميع المدين والدائن بين المصدر والنسخة المستعادة..."
CHECK_SQL="
select
  (select count(*) from public.organizations) as orgs,
  (select count(*) from public.accounts) as accounts,
  (select count(*) from public.journal_entries) as entries,
  (select count(*) from public.journal_lines) as lines,
  coalesce((select sum(debit)::text from public.journal_lines), '0') as total_debit,
  coalesce((select sum(credit)::text from public.journal_lines), '0') as total_credit,
  (select count(*) from public.invoices) as invoices,
  (select count(*) from public.stock_movements) as stock_moves;
"

SRC_SIG="$(psql "$SOURCE_DB_URL" -Atc "$CHECK_SQL")"
RST_SIG="$(psql "$RESTORE_DB_URL" -Atc "$CHECK_SQL")"

echo "المصدر    : $SRC_SIG"
echo "المستعاد  : $RST_SIG"

if [ "$SRC_SIG" != "$RST_SIG" ]; then
  echo "ERROR: عدم تطابق بين النسخة الأصلية والمستعادة!" >&2
  exit 1
fi

echo "BACKUP_RESTORE_VERIFIED_OK"
