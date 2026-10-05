/**
 * every admin page rises in as it opens, like the rest of the app's pages
 * (`page-cascade` in globals.css). a template, not the layout: the layout and
 * its sidebar persist across admin pages, and a template remounts on each one,
 * so the page moves and the navigation stays still.
 */
export default function AdminTemplate({ children }: { children: React.ReactNode }) {
  return <div className="page-cascade">{children}</div>;
}
