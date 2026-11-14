/**
 * The OS line under a hostname, in the forms it may shrink to when the column
 * is narrow, longest first. The full string always comes first and stays in
 * the element's title, so nothing is lost, only abbreviated:
 *
 *   "Windows 11 Pro 23H2" → "Win 11 Pro 23H2" → "Win 11 Pro"
 *   "Ubuntu 24.04.5 LTS"  → "Ubuntu 24.04.5"  → "Ubuntu 24.04" → "Ubuntu 24"
 *
 * A step that changes nothing is skipped, so an unknown OS string yields just
 * itself.
 */
export function osLabelCandidates(osVersion: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim().replace(/\s+/g, ' ');
    if (t && !out.includes(t)) out.push(t);
  };

  push(osVersion);
  let s = osVersion.trim().replace(/\s+/g, ' ');

  // windows: the family name shortens first, then the feature-update id
  // (23H2, 25H2, 1809 …) comes off the end.
  if (/^windows\b/i.test(s)) {
    s = s.replace(/^windows\b/i, 'Win');
    push(s);
    s = s.replace(/\s+[0-9A-Za-z]{4}$/, '');
    push(s);
    return out;
  }

  // everything else: a trailing "LTS" goes, then the version loses one dotted
  // component at a time.
  s = s.replace(/\s+LTS$/i, '');
  push(s);
  let m: RegExpMatchArray | null;
  while ((m = s.match(/(\d+(?:\.\d+)+)/))) {
    const shorter = m[1].replace(/\.\d+$/, '');
    if (shorter === m[1]) break;
    s = s.replace(m[1], shorter);
    push(s);
  }
  return out;
}
