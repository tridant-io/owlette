import { Button } from '@/components/ui/button';

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-0.5 rounded-lg border border-border bg-card p-0.5">
      {options.map((o) => (
        <Button key={o.value} variant="ghost" size="xs" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}
