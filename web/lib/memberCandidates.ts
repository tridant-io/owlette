export interface MemberCandidate {
  uid: string;
  email: string | null;
  displayName: string | null;
}

// the members route refuses a longer address, so a longer one is never offered as a target
const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function candidateLabel(c: MemberCandidate): string {
  return c.email || c.displayName || 'this person';
}

export function isFullEmail(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(trimmed);
}

export function rankMemberCandidates(
  query: string,
  candidates: readonly MemberCandidate[],
  limit = 6,
): MemberCandidate[] {
  const needle = query.trim().toLowerCase();
  // the candidates route already sorts its rows, so an empty query keeps that order
  if (!needle) return candidates.slice(0, limit);

  const prefix: MemberCandidate[] = [];
  const substring: MemberCandidate[] = [];
  for (const candidate of candidates) {
    const email = (candidate.email ?? '').toLowerCase();
    const name = (candidate.displayName ?? '').toLowerCase();
    if (
      email.startsWith(needle) ||
      name.startsWith(needle) ||
      name.split(/\s+/).some((word) => word.startsWith(needle))
    ) {
      prefix.push(candidate);
    } else if (email.includes(needle) || name.includes(needle)) {
      substring.push(candidate);
    }
  }

  return [...prefix, ...substring].slice(0, limit);
}
