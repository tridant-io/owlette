import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createRelativeLink } from "fumadocs-ui/mdx";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

type PageProps = {
  params: Promise<{
    slug?: string[];
  }>;
};

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const { title, description } = page.data;
  const path = slug?.length ? `/docs/${slug.join("/")}` : "/docs";

  // `openGraph` and `twitter` MUST be set here, not just `title`/`description`.
  // Next merges metadata field by field, so a page that sets only `title`
  // inherits the ROOT layout's whole `openGraph` object — which is why every
  // docs page was sharing the marketing card instead of its own.
  return {
    title,
    description,
    alternates: {
      canonical: path,
      // Re-declared because page-level `alternates` REPLACES the root's rather
      // than merging; omitting this drops the /llms.txt hint on docs pages.
      types: { "text/plain": "/llms.txt" },
    },
    openGraph: {
      title,
      description,
      url: path,
      siteName: "owlette",
      type: "article",
      images: [
        {
          url: `/docs-og${path.replace("/docs", "")}/image.png`,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`/docs-og${path.replace("/docs", "")}/image.png`],
    },
  };
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const MDXContent = page.data.body;
  const { tocDepth } = page.data;
  const toc = tocDepth
    ? page.data.toc.filter((item) => item.depth <= tocDepth)
    : page.data.toc;

  return (
    <DocsPage toc={toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDXContent
          components={getMDXComponents({
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}
