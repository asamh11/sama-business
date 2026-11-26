// Voice, AI and OCR may only PREPARE operations. A draft becomes postable
// solely through an explicit human confirmation. There is no other path.

import { type JournalLine, validateJournal } from "./journal.ts";

export type DraftSource = "voice" | "ai" | "ocr" | "manual";

export interface DraftOperation {
  readonly id: string;
  readonly source: DraftSource;
  readonly summary: string; // shown to the user in plain language
  readonly lines: readonly JournalLine[];
  readonly status: "pending_confirmation" | "confirmed" | "rejected";
}

export function newDraft(
  id: string,
  source: DraftSource,
  summary: string,
  lines: readonly JournalLine[],
): DraftOperation {
  validateJournal(lines);
  return { id, source, summary, lines, status: "pending_confirmation" };
}

/** Only a signed-in human (userId) can confirm; the draft id doubles as idempotency key. */
export function confirmDraft(d: DraftOperation, userId: string) {
  if (!userId) throw new Error("confirmation requires a signed-in user");
  if (d.status !== "pending_confirmation") throw new Error(`draft is ${d.status}`);
  validateJournal(d.lines);
  return { idempotencyKey: `draft:${d.id}`, confirmedBy: userId, lines: d.lines };
}
