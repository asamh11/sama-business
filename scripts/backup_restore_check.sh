#!/usr/bin/env bash
# Backup/restore drill. NOT yet run: first execution may need adjustments.
# SOURCE_DB_URL  database to back up (use local/staging, never production first)
# RESTORE_DB_URL EMPTY scratch database with the same migrations applied
set -euo pipefail
: "${SOURCE_DB_URL:?set SOURCE_DB_URL}" "${RESTORE_DB_URL:?set RESTORE_DB_URL}"
dump="$(mktemp)"; trap 'rm -f "$dump"' EXIT

fingerprint() {  # row counts + ledger totals per currency
  psql "$1" -Atq -c "
    select 'entries', count(*) from journal_entries union all
    select 'lines', count(*) from journal_lines union all
    select 'accounts', count(*) from accounts union all
    select 'audit', count(*) from audit_logs union all
    select 'debit/'||currency, sum(debit) from journal_lines group by currency union all
    select 'credit/'||currency, sum(credit) from journal_lines group by currency
    order by 1"
}

pg_dump "$SOURCE_DB_URL" -Fc --data-only --schema=public -t auth.users -f "$dump"
pg_restore --data-only --disable-triggers --no-owner -d "$RESTORE_DB_URL" "$dump"

if diff <(fingerprint "$SOURCE_DB_URL") <(fingerprint "$RESTORE_DB_URL"); then
  echo "OK: restored data matches the source"
else
  echo "MISMATCH: restore does not match the source" >&2; exit 1
fi
