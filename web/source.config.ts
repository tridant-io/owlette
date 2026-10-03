import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { pageSchema } from "fumadocs-core/source/schema";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({
      // search-only synonyms, folded into the index by app/api/search/route.ts.
      // for terms an operator types that our prose never uses — we write
      // "reboot" and "roost", people search "restart" and "projects".
      keywords: z.array(z.string()).optional(),
    }),
  },
});

export default defineConfig({
  mdxOptions: {
    // Rewrites ```mermaid fences into <Mermaid chart="..." /> (registered in
    // mdx-components.tsx) so they render as real diagrams instead of raw text.
    remarkPlugins: [remarkMdxMermaid],
    // fumadocs' default day theme (github-light) has keywords under 4.5:1 on our
    // code blocks; the high-contrast one clears AA for every token. passing
    // `themes` drops fumadocs' defaults, so `defaultColor: false` is restated to
    // keep the per-theme css variables.
    rehypeCodeOptions: {
      themes: { light: "github-light-high-contrast", dark: "github-dark" },
      defaultColor: false,
    },
  },
});
