import { isFullEmail } from '@/lib/memberCandidates';

export const MAX_RECIPIENTS = 10;

export type RecipientsResult =
  | { ok: true; recipients: string[] }
  | { ok: false; invalid: string[]; tooMany: boolean };

/** trims, lowercases and dedupes a list of addresses; names the entries that are not one. */
export function normaliseRecipients(input: unknown): RecipientsResult {
  if (!Array.isArray(input)) return { ok: false, invalid: [String(input)], tooMany: false };

  const recipients: string[] = [];
  const invalid: string[] = [];
  for (const entry of input) {
    const address = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!isFullEmail(address)) invalid.push(String(entry));
    else if (!recipients.includes(address)) recipients.push(address);
  }

  const tooMany = recipients.length > MAX_RECIPIENTS;
  if (invalid.length > 0 || tooMany) return { ok: false, invalid, tooMany };
  return { ok: true, recipients };
}
