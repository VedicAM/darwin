/**
 * The scientific workspace: the right half of the window.
 *
 * A viewer, not a second transcript. The chat says what the agent said; this
 * says what it did and what came out. Three fixed regions — status line, artifact
 * tabs, body — so the artifact being read never moves, and a long alignment
 * scrolls inside the body instead of pushing the window wide.
 *
 * Selection follows the newest artifact until the user picks one, so a run reads
 * itself as it streams; after that their choice sticks.
 */

import { useMemo } from "react";
import { Dna, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type { Artifact } from "@/lib/artifacts/types";
import type { RunStatus } from "@/lib/artifacts/types";
import { ARTIFACT_META, RENDERERS } from "./renderers";
import { countFailed, workflowSummary } from "./WorkflowView";

const STATUS_LABEL: Record<RunStatus, string> = {
  idle: "idle",
  running: "running",
  settled: "idle",
  error: "needs attention",
};

const STATUS_DOT: Record<RunStatus, string> = {
  idle: "bg-muted-foreground/40",
  running: "bg-primary animate-pulse",
  settled: "bg-muted-foreground/40",
  error: "bg-destructive",
};

function Tab({
  artifact,
  active,
  summary,
  onSelect,
}: {
  artifact: Artifact;
  active: boolean;
  summary?: string;
  onSelect: (id: string) => void;
}) {
  const meta = ARTIFACT_META[artifact.type];
  const Icon = meta.Icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(artifact.id)}
      title={artifact.title}
      className={cn(
        "flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[11.5px] whitespace-nowrap transition-colors",
        active
          ? "border-foreground text-foreground"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      <Icon aria-hidden className="size-3.5 opacity-70" />
      {meta.label}
      {summary ? (
        <span className="text-muted-foreground/80 font-mono text-[10px] tabular-nums">{summary}</span>
      ) : null}
    </button>
  );
}

export interface WorkspaceProps {
  artifacts: Artifact[];
  selected: Artifact | null;
  workflow: Extract<Artifact, { type: "workflow" }>;
  hasRun: boolean;
  onSelect: (id: string) => void;
  onAdd: (artifact: Artifact) => void;
}

export function Workspace({
  artifacts,
  selected,
  workflow,
  hasRun,
  onSelect,
  onAdd,
}: WorkspaceProps) {
  const Renderer = selected ? RENDERERS[selected.type] : null;
  const failed = countFailed(workflow);
  const produced = artifacts.length - 1;

  const status = useMemo(() => {
    const counts = { running: 0, done: 0, failed: 0 };
    for (const step of workflow.steps) {
      if (step.status === "running") counts.running += 1;
      else if (step.status === "completed") counts.done += 1;
      else if (step.status === "failed") counts.failed += 1;
    }
    return counts;
  }, [workflow.steps]);

  return (
    <section aria-label="Scientific workspace" className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-3 px-5 pt-12 pb-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium">Scientific Workspace</h2>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            {hasRun
              ? `${workflowSummary(workflow)} · ${produced} artifact${produced === 1 ? "" : "s"}`
              : "no analysis yet"}
          </p>
        </div>
        <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[10.5px]">
          {failed > 0 ? (
            <TriangleAlert aria-hidden className="text-destructive size-3" />
          ) : (
            <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[workflow.status])} />
          )}
          {failed > 0 ? `${failed} failed` : STATUS_LABEL[workflow.status]}
        </span>
      </header>

      {artifacts.length > 0 ? (
        <div className="border-border flex shrink-0 items-end gap-1 overflow-x-auto border-b px-3">
          {artifacts.map((artifact) => (
            <Tab
              key={artifact.id}
              artifact={artifact}
              active={selected?.id === artifact.id}
              summary={artifact.type === "workflow" ? workflowSummary(artifact) : undefined}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}

      {hasRun ? (
        Renderer && selected ? (
          <Renderer
            key={selected.id}
            artifact={selected}
            artifacts={artifacts}
            onSelect={onSelect}
            onAdd={onAdd}
          />
        ) : (
          <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center px-8 text-center text-[12px]">
            No renderer is registered for {selected ? selected.type : "this artifact"}.
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <Dna aria-hidden className="text-muted-foreground size-5 opacity-50" />
          <p className="text-[13px] font-medium">Nothing to show yet</p>
          <p className="text-muted-foreground max-w-72 text-[12px] leading-relaxed">
            Run an analysis with Pi. Sequences, alignments, structures, literature and tool results appear here
            as they are produced.
          </p>
        </div>
      )}

      {status.running > 0 ? (
        <span className="sr-only" role="status">
          {status.running} step in progress, {status.done} complete
        </span>
      ) : null}
    </section>
  );
}
