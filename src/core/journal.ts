// Pure double-entry rules. The database enforces the same rules again
// (see supabase/migrations); this layer gives early, readable errors.

export interface JournalLine {
  readonly accountId: string;
  readonly currency: string;
  readonly debit: bigint;
  readonly credit: bigint;
}

export type JournalErrorCode = "TOO_FEW_LINES" | "INVALID_LINE" | "UNBALANCED";

export class JournalError extends Error {
  readonly code: JournalErrorCode;
  constructor(code: JournalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function validateJournal(lines: readonly JournalLine[]): void {
  if (lines.length < 2) {
    throw new JournalError("TOO_FEW_LINES", "an entry needs at least 2 lines");
  }
  const totals = new Map<string, bigint>();
  for (const l of lines) {
    if (l.debit < 0n || l.credit < 0n || (l.debit > 0n) === (l.credit > 0n)) {
      throw new JournalError("INVALID_LINE", "each line needs exactly one positive side");
    }
    totals.set(l.currency, (totals.get(l.currency) ?? 0n) + l.debit - l.credit);
  }
  for (const [currency, diff] of totals) {
    if (diff !== 0n) {
      throw new JournalError("UNBALANCED", `entry is unbalanced in ${currency}`);
    }
  }
}

/** Exact mirror of an entry: same accounts, currencies, amounts; sides swapped. */
export function reverseLines(lines: readonly JournalLine[]): JournalLine[] {
  return lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

export function trialBalance(lines: readonly JournalLine[]) {
  const out = new Map<string, { debit: bigint; credit: bigint }>();
  for (const l of lines) {
    const key = `${l.accountId}|${l.currency}`;
    const cur = out.get(key) ?? { debit: 0n, credit: 0n };
    out.set(key, { debit: cur.debit + l.debit, credit: cur.credit + l.credit });
  }
  return out;
}

/** JSON-safe payload for the post_journal_entry RPC (amounts as strings). */
export function toRpcLines(lines: readonly JournalLine[]) {
  return lines.map((l) => ({
    account_id: l.accountId,
    currency: l.currency,
    debit: l.debit.toString(),
    credit: l.credit.toString(),
  }));
}
