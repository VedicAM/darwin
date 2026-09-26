/**
 * Panel furniture: the states every view needs, and the small typographic
 * pieces they share.
 *
 * Four states are explicit — loading, ready, empty, error — because the failure
 * mode of a scientific viewer is a blank rectangle that looks like "no data".
 * Saying "the tool returned an invalid base-pair index" is the difference
 * between a bug report and a shrug.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { TriangleAlert } from "lucide-react";
import { cn } from "cn";

/** Quiet placeholder for a view with nothing to show yet. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center",
        className,
      )}
    >
      <Icon aria-hidden className="size-4 opacity-60" />
      <p className="text-foreground text-[13px] font-medium">{title}</p>
      {children ? <div className="max-w-72 text-[12px] leading-relaxed">{children}</div> : null}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center gap-2 px-6 py-10 text-[12px]"
    >
      <span
        aria-hidden
        className="border-muted-foreground/30 border-t-foreground/70 size-3 animate-spin rounded-full border-2"
      />
      {label}
    </div>
  );
}

/**
 * A failure, in the user's terms. `detail` carries the tool's own message —
 * the first line of it, never a stack trace.
 */
export function ErrorState({
  title,
  children,
  detail,
  className,
}: {
  title: string;
  children?: ReactNode;
  detail?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center", className)}
    >
      <TriangleAlert aria-hidden className="text-destructive size-4" />
      <p className="text-foreground text-[13px] font-medium">{title}</p>
      {children ? <div className="text-muted-foreground max-w-80 text-[12px] leading-relaxed">{children}</div> : null}
      {detail ? (
        <p className="text-muted-foreground/80 bg-muted mt-1 max-w-80 rounded-md px-2.5 py-1.5 text-left font-mono text-[11px] leading-relaxed break-words">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

/** A run of `label value` pairs, e.g. Length / GC / MW. */
export function StatLine({ stats }: { stats: { label: string; value: string }[] }) {
  return (
    <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {stats.map((stat) => (
        <div key={stat.label} className="flex items-baseline gap-1.5">
          <dt className="text-muted-foreground text-[11px]">{stat.label}</dt>
          <dd className="font-mono text-[11px] tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Small uppercase-ish label above a block. */
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-muted-foreground text-[10px] font-medium tracking-[0.08em] uppercase", className)}>
      {children}
    </div>
  );
}

/** Header for one artifact: title, optional subtitle, right-aligned actions. */
export function ArtifactHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-[13px] font-medium">{title}</h2>
        {subtitle ? <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/** Sticky footer for a readout, e.g. a selection summary. */
export function Readout({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2 text-[11px]">
      {children}
    </div>
  );
}
