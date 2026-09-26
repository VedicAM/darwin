/**
 * The analysis pipeline.
 *
 * A vertical activity list, not a node diagram: at this width a diagram spends
 * its space on connectors and gets none for the two things that matter, which
 * are what the step was and what it produced.
 *
 * Steps are observed, not declared — see `lib/workspace.ts`. Every state shown
 * here is therefore backed by a real event, and `pending` only appears when a
 * producer declares a step before running it.
 */

import type { LucideIcon } from "lucide-react";
import { Ban, CircleCheck, CircleDot, Clock, Workflow } from "lucide-react";
import { cn } from "cn";
import type { Artifact, StepStatus, WorkflowArtifact, WorkflowStep } from "@/lib/artifacts/types";
import { EmptyState, FieldLabel } from "./primitives";

const STATUS_ICON: Record<StepStatus, LucideIcon> = {
  completed: CircleCheck,
  running: CircleDot,
  failed: Ban,
  pending: Clock,
};

const STATUS_CLASS: Record<StepStatus, string> = {
  completed: "text-muted-foreground",
  running: "text-foreground",
  failed: "text-destructive",
  pending: "text-muted-foreground/60",
};

function elapsed(step: WorkflowStep): string | null {
  if (step.status === "running" || step.endedAt === undefined) return null;
  const ms = step.endedAt - step.startedAt;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

function StepRow({
  step,
  artifacts,
  onSelect,
}: {
  step: WorkflowStep;
  artifacts: Artifact[];
  onSelect: (id: string) => void;
}) {
  const Icon = STATUS_ICON[step.status];
  const produced = step.artifacts
    .map((id) => artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const duration = elapsed(step);

  return (
    <li className="relative flex gap-2.5 pb-3 last:pb-0">
      {/* The rail: one segment per step, so the list reads as a single line of
          work rather than as unrelated rows. */}
      <div className="flex w-3.5 shrink-0 flex-col items-center">
        <Icon
          aria-hidden
          className={cn(
            "mt-px size-3.5",
            STATUS_CLASS[step.status],
            step.status === "running" && "animate-pulse",
          )}
        />
        <span aria-hidden className="bg-border mt-1 w-px flex-1" />
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        <div className="flex items-baseline justify-between gap-3">
          <p
            className={cn(
              "truncate text-[12.5px]",
              step.status === "pending" ? "text-muted-foreground" : "text-foreground",
              step.status === "running" && "font-medium",
            )}
          >
            {step.label}
          </p>
          {duration ? (
            <span className="text-muted-foreground shrink-0 font-mono text-[10.5px] tabular-nums">{duration}</span>
          ) : null}
        </div>

        {step.detail ? (
          <p className="text-muted-foreground/90 mt-0.5 truncate font-mono text-[11px]" title={step.detail}>
            {step.detail}
          </p>
        ) : null}

        {step.progress ? (
          <p className="text-muted-foreground/70 mt-0.5 truncate font-mono text-[11px] italic">
            {step.progress}
          </p>
        ) : null}

        {step.error ? (
          <p className="text-destructive mt-0.5 font-mono text-[11px] leading-relaxed break-words">
            {step.error}
          </p>
        ) : null}

        {produced.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {produced.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onSelect(artifact.id)}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border px-1.5 py-0.5 text-[10.5px] transition-colors"
              >
                {artifact.title}
              </button>
            ))}
          </div>
        ) : null}

        <span className="sr-only">{statusWord(step.status)}</span>
      </div>
    </li>
  );
}

function statusWord(status: StepStatus): string {
  switch (status) {
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
  }
}

export function WorkflowView({
  artifact,
  artifacts,
  onSelect,
}: {
  artifact: WorkflowArtifact;
  artifacts: Artifact[];
  onSelect: (id: string) => void;
}) {
  const { status, steps, goal } = artifact;
  const done = steps.filter((step) => step.status === "completed").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const running = steps.find((step) => step.status === "running");

  if (steps.length === 0) {
    if (status === "running") {
      return (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-2 px-5 py-8">
          <p className="text-foreground text-[12.5px] font-medium">Analyzing…</p>
          <p className="text-muted-foreground text-[11.5px] leading-relaxed">
            Steps appear as the agent calls tools. Anything it produces shows up below the workflow.
          </p>
        </div>
      );
    }
    return (
      <EmptyState icon={Workflow} title="No activity yet">
        The pipeline fills in as the agent calls tools. Each step links to whatever it produced.
      </EmptyState>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 py-4">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <FieldLabel>Pipeline</FieldLabel>
          <span className="text-muted-foreground font-mono text-[10.5px] tabular-nums">
            {done}/{steps.length} complete{failed > 0 ? ` · ${failed} failed` : ""}
          </span>
        </div>

        {goal ? (
          <p className="text-muted-foreground mb-3 line-clamp-2 text-[11.5px] leading-relaxed">{goal}</p>
        ) : null}

        <ol className="m-0 list-none p-0">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} artifacts={artifacts} onSelect={onSelect} />
          ))}
        </ol>

        {status === "running" && running === undefined ? (
          <p className="text-muted-foreground pl-[22px] text-[11.5px]">Working…</p>
        ) : null}
      </div>
    </div>
  );
}

/** Shown as the workflow tab's summary when the panel is narrow. */
export function workflowSummary(artifact: WorkflowArtifact): string {
  const { steps, status } = artifact;
  if (steps.length === 0) return status === "running" ? "starting" : "idle";
  const done = steps.filter((step) => step.status === "completed").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const running = steps.find((step) => step.status === "running");
  if (running) return `${done}/${steps.length} · ${running.label.toLowerCase()}`;
  if (failed > 0) return `${done}/${steps.length} · ${failed} failed`;
  return `${done}/${steps.length}`;
}

/** Exported for the panel header, which needs the same failure count. */
export function countFailed(artifact: WorkflowArtifact): number {
  return artifact.steps.filter((step) => step.status === "failed").length;
}
