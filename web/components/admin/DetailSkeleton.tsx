export function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className="h-4 w-32 rounded bg-muted motion-safe:animate-pulse" />
      <div className="h-8 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
      <div className="h-40 rounded-xl bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
