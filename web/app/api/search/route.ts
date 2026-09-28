import { createFromSource } from "fumadocs-core/search/server";
import type { InferPageType } from "fumadocs-core/source";
import { source } from "@/lib/source";
import { titleFirst } from "@/lib/docsSearchRank";

// fumadocs hands the engine `limit: undefined` whenever the client omits one,
// which clobbers its own default of 60 and returns every matching section —
// 745 rows for a six-word question. the bundled client never sends a limit.
const DEFAULT_LIMIT = 24;

// cap the sections any one page contributes, so the changelog can't fill the
// dialog on its own.
const GROUP_BY = { properties: ["page_id"], maxResult: 3 };

// fold `keywords` frontmatter into the indexed text, as an extra content block.
// it is how a page answers to words our prose never uses.
function buildIndex(page: InferPageType<typeof source>) {
  const { title, description, structuredData, keywords } = page.data;

  return {
    id: page.url,
    url: page.url,
    title,
    description,
    structuredData: keywords?.length
      ? {
          ...structuredData,
          contents: [
            ...structuredData.contents,
            { heading: undefined, content: keywords.join(", ") },
          ],
        }
      : structuredData,
  };
}

const exact = createFromSource(source, {
  language: "english",
  search: { groupBy: GROUP_BY },
  buildIndex,
});

// one edit of slack, so "sceduled" still finds something. measured against our
// own queries it costs precision on everything that already worked, so it only
// runs when the exact pass came back empty — and its index builds lazily, on
// the first typo.
const fuzzy = createFromSource(source, {
  language: "english",
  search: { groupBy: GROUP_BY, tolerance: 1 },
  buildIndex,
});

// search deeper than the list shows, so a title match past the cut still
// reaches the reorder (lib/docsSearchRank.ts). measured 2026-09-23 on the
// 21-query harness: MRR 0.683 → 0.857, "roost" from absent to first.
const SEARCH_DEPTH = 60;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("query");
  if (!query) return Response.json([]);

  const requested = Number(params.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_LIMIT;
  const options = {
    tag: params.get("tag")?.split(","),
    locale: params.get("locale"),
    limit: Math.max(limit, SEARCH_DEPTH),
  };

  const results = await exact.search(query, options);
  const rows = results.length > 0 ? results : await fuzzy.search(query, options);
  return Response.json(titleFirst(rows, query, limit));
}
