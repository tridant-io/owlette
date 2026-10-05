import { PageCascade } from '@/components/PageCascade';

/**
 * every admin page fades in as it opens, like the rest of the app's pages. a
 * template, not the layout: the layout and its sidebar persist across admin
 * pages, and a template remounts on each one, so the page fades and the
 * navigation stays still.
 */
export default function AdminTemplate({ children }: { children: React.ReactNode }) {
  return <PageCascade>{children}</PageCascade>;
}
