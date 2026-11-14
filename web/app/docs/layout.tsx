import "./docs.css";

import { source } from "@/lib/source";
import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { Metadata } from "next";
import { OwletteEyeIcon } from "@/components/landing/OwletteEye";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  icons: {
    icon: "/owlette-eye.svg",
    shortcut: "/owlette-eye.svg",
    apple: "/owlette-icon.png",
  },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{ enabled: false }}
      i18n={{
        translations: {
          search: "search",
          searchNoResult: "no results found",
          toc: "on this page",
          tocNoHeadings: "no headings",
          lastUpdate: "last updated on",
          chooseLanguage: "choose a language",
          nextPage: "next page",
          previousPage: "previous page",
          chooseTheme: "theme",
          editOnGithub: "edit on github",
        },
      }}
    >
      <DocsLayout
        tree={source.pageTree}
        nav={{
          title: (
            <span className="docs-nav-title">
              <OwletteEyeIcon size={20} />
              <span>owlette docs</span>
            </span>
          ),
          url: "/docs",
        }}
        themeSwitch={{ enabled: false }}
        sidebar={{ defaultOpenLevel: 0 }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
