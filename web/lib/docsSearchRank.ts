/**
 * Docs search result ordering, applied after the engine has answered.
 *
 * Rows come back grouped: a page row, then that page's matching sections. The
 * engine orders the groups by section score, so a page whose title IS the
 * query ("roost") loses to pages that repeat the word in short code blocks and
 * can fall off the end of the list. Pages whose title carries every query word
 * move to the front; everything else keeps the engine's order.
 */

export interface SearchRow {
  type: string;
  url: string;
  content: string;
}

export function titleFirst<R extends SearchRow>(rows: R[], query: string, limit: number): R[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return rows.slice(0, limit);

  const groups: R[][] = [];
  for (const row of rows) {
    if (row.type === "page" || groups.length === 0) groups.push([row]);
    else groups[groups.length - 1].push(row);
  }
  const titled = groups.filter(([page]) => {
    const title = page.type === "page" ? page.content.toLowerCase() : "";
    return words.every((w) => title.includes(w));
  });
  // two pages can share a title (the roost overview and the cli's `roost`
  // reference): the shallower url is the overview, so it goes first.
  titled.sort(([a], [b]) => a.url.split("/").length - b.url.split("/").length);
  const rest = groups.filter((g) => !titled.includes(g));
  return [...titled, ...rest].flat().slice(0, limit);
}
