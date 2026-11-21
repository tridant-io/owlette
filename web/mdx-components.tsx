import type { ComponentProps } from "react";
import type { StaticImageData } from "next/image";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Mermaid } from "@/components/mdx/mermaid";
import { ThemedImage } from "@/components/ThemedImage";
import { cn } from "@/lib/utils";
import lightVariants from "@/public/docs-screens/light-variants.json";

/** written by `scripts/refresh-docs-screens.mjs` from the files on disk */
const LIGHT_SCREENS = new Set<string>(lightVariants);

// fumadocs' own img sizes, so a paired screenshot loads the same widths
const DOCS_IMAGE_SIZES = "(max-width: 768px) 100vw, (max-width: 1200px) 70vw, 900px";

/**
 * a docs screenshot with a light capture shows the one that matches the theme.
 * fumadocs' remark-image turns `![](/docs-screens/x.png)` into a static import,
 * so `src` arrives as image data whose url keeps the file name ahead of the
 * hash: `/_next/static/media/x.3fa9c1.png`, plus next's asset suffix when a
 * deployment id is set.
 */
function DocsImage(props: ComponentProps<"img">) {
  const src = props.src as string | StaticImageData | undefined;
  const name = typeof src === "object" ? src.src.match(/^\/_next\/static\/media\/([\w-]+)\.[\w-]+\.png(?:\?|$)/)?.[1] : undefined;
  if (typeof src !== "object" || !name || !LIGHT_SCREENS.has(name)) {
    return <defaultMdxComponents.img {...props} />;
  }

  return (
    <ThemedImage
      dark={src.src}
      light={`/docs-screens/${name}-light.png`}
      alt={props.alt ?? ""}
      width={src.width}
      height={src.height}
      sizes={DOCS_IMAGE_SIZES}
      className={cn("rounded-lg", props.className)}
    />
  );
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    img: DocsImage,
    Mermaid,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
