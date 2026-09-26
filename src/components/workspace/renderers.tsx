/**
 * The renderer registry: `artifact.type` decides what draws.
 *
 * This is the whole extension contract for the panel. A renderer is registered
 * against a type and never against a tool, so adding an artifact is: one member
 * in the `Artifact` union, one projector that emits it, one entry here. Nothing
 * in `Workspace.tsx` changes, and no component needs to know which biological
 * tool produced the data.
 */

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ChartSpline,
  Dna,
  Rows3,
  Rss,
  Spline,
  Table2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type {
  Artifact,
  ArtifactType,
} from "@/lib/artifacts/types";
import { AlignmentView } from "./AlignmentView";
import { PlotView } from "./PlotView";
import { ResearchView } from "./ResearchView";
import { SequenceView } from "./SequenceView";
import { StructureView } from "./StructureView";
import { TableView } from "./TableView";
import { WorkflowView } from "./WorkflowView";

export interface ViewProps {
  artifact: Artifact;
  /** Every artifact in the run, so a view can link to a sibling. */
  artifacts: Artifact[];
  onSelect: (id: string) => void;
  onAdd: (artifact: Artifact) => void;
}

/**
 * Widen a view that takes one concrete artifact into one that takes any. The
 * guard is what makes the pairing safe: a mismatched artifact renders nothing
 * rather than reaching into a payload that is not there.
 */
function view<A extends Artifact, P extends { artifact: A }>(
  guard: (artifact: Artifact) => artifact is A,
  Component: ComponentType<P>,
): ComponentType<ViewProps> {
  function Render(props: ViewProps) {
    if (!guard(props.artifact)) return null;
    return <Component {...(props as unknown as P)} />;
  }
  Render.displayName = `view(${Component.displayName ?? Component.name ?? "Artifact"})`;
  return Render;
}

const isType =
  <T extends ArtifactType>(type: T) =>
  (artifact: Artifact): artifact is Extract<Artifact, { type: T }> =>
    artifact.type === type;

export interface ArtifactMeta {
  /** Tab label. */
  label: string;
  Icon: LucideIcon;
  /** Fallback title for an artifact that arrives without one. */
  fallbackTitle: string;
}

export const ARTIFACT_META: Record<ArtifactType, ArtifactMeta> = {
  workflow: { label: "Workflow", Icon: WorkflowIcon, fallbackTitle: "Analysis" },
  sequence: { label: "Sequence", Icon: Dna, fallbackTitle: "Sequence" },
  alignment: { label: "Alignment", Icon: Rows3, fallbackTitle: "Alignment" },
  rna_structure: { label: "Structure", Icon: Spline, fallbackTitle: "RNA structure" },
  "research.paper": { label: "Papers", Icon: Rss, fallbackTitle: "Papers" },
  "research.repository": { label: "Repositories", Icon: Rows3, fallbackTitle: "Repositories" },
  table: { label: "Table", Icon: Table2, fallbackTitle: "Table" },
  plot: { label: "Plot", Icon: ChartSpline, fallbackTitle: "Plot" },
};

export const RENDERERS: Record<ArtifactType, ComponentType<ViewProps>> = {
  workflow: view(isType("workflow"), WorkflowView),
  sequence: view(isType("sequence"), SequenceView),
  alignment: view(isType("alignment"), AlignmentView),
  rna_structure: view(isType("rna_structure"), StructureView),
  "research.paper": view(isType("research.paper"), ResearchView),
  "research.repository": view(isType("research.repository"), ResearchView),
  table: view(isType("table"), TableView),
  plot: view(isType("plot"), PlotView),
};
