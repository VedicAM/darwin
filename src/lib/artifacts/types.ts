/**
 * The artifact model.
 *
 * An artifact is something an analysis *produced* — a sequence, an alignment, a
 * structure, a set of papers, a numeric table. The right-hand panel is a viewer
 * over this model: it picks a renderer from `artifact.type` and nothing else.
 * No renderer is allowed to know which tool emitted its artifact, so a new
 * biological tool becomes visible in the UI by emitting a shape, not by
 * touching a component.
 *
 * Adding a type is three edits: the union member below, a projector in
 * `project.ts` that produces it, and a renderer in
 * `components/workspace/renderers.tsx`.
 */

export type ArtifactType =
  | "workflow"
  | "sequence"
  | "alignment"
  | "rna_structure"
  | "research.paper"
  | "research.repository"
  | "table"
  | "plot"
  | "experiment";

/** Every type, in the order a new run produces them. Used for iteration. */
export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "workflow",
  "experiment",
  "sequence",
  "alignment",
  "rna_structure",
  "research.paper",
  "research.repository",
  "table",
  "plot",
];

export interface ArtifactBase {
  /**
   * Stable and deterministic: derived from Pi's `toolCallId`, never from a
   * clock or a random number, so a re-projection of the same tool result
   * replaces its own artifact instead of piling up beside it.
   */
  id: string;
  type: ArtifactType;
  title: string;
  createdAt: number;
  /** The tool call this came from, when it came from one. */
  source?: ArtifactSource;
}

export interface ArtifactSource {
  toolCallId: string;
  toolName: string;
}

export type Artifact =
  | WorkflowArtifact
  | SequenceArtifact
  | AlignmentArtifact
  | RNAStructureArtifact
  | ResearchArtifact
  | TableArtifact
  | PlotArtifact
  | ExperimentArtifact;

// --- workflow ---------------------------------------------------------------

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface WorkflowStep {
  id: string;
  label: string;
  /** One-line summary of the call's arguments, e.g. the path it read. */
  detail?: string;
  status: StepStatus;
  toolName: string;
  startedAt: number;
  endedAt?: number;
  /** Present when `status` is `failed`. */
  error?: string;
  /** Last line of streamed output while `running`. */
  progress?: string;
  /**
   * The call's primitive arguments, kept so a result arriving without its
   * start event can still be titled, and so the step can show what it asked
   * for. Objects are dropped: they are already held by Pi and would pin
   * megabytes for the length of the run.
   */
  args?: Record<string, unknown>;
  /** Artifacts this step produced, in creation order. */
  artifacts: string[];
}

export type RunStatus = "idle" | "running" | "settled" | "error";

/**
 * The analysis pipeline as it actually happened. Steps come from real
 * `tool_execution_*` events rather than a plan the agent never stated, so a
 * `completed` step means a tool really returned. `pending` is reachable when a
 * producer declares steps ahead of time (see `WorkflowStep.status`).
 */
export interface WorkflowArtifact extends ArtifactBase {
  type: "workflow";
  status: RunStatus;
  /** The user's prompt, as the run's title. */
  goal?: string;
  steps: WorkflowStep[];
}

// --- sequence ---------------------------------------------------------------

export interface SequenceRecord {
  id: string;
  name: string;
  description?: string;
  /** Uppercase residues. May contain gaps when the record came from an
   *  alignment; a plain sequence will not. */
  sequence: string;
  length: number;
  /** Fraction of G+C over unambiguous bases, 0..1. */
  gc: number;
  /** Residue counts, including gaps and `N`. */
  composition: Record<string, number>;
}

export interface SequenceArtifact extends ArtifactBase {
  type: "sequence";
  records: SequenceRecord[];
  /** Dot-bracket notation found alongside the records, if any. */
  structure?: string;
}

// --- alignment --------------------------------------------------------------

export interface AlignmentRow {
  id: string;
  name: string;
  description?: string;
  /** One row of gapped residues, exactly `width` characters. */
  row: string;
}

export interface AlignmentArtifact extends ArtifactBase {
  type: "alignment";
  rows: AlignmentRow[];
  width: number;
  format: string;
  /**
   * Per-column conservation, 0..1: the most common non-gap residue's share of
   * the column. Positional only — no substitution matrix — so it is a guide to
   * where the alignment is pinned, not a scoring result.
   */
  conservation?: number[];
}

// --- rna structure ----------------------------------------------------------

export interface StructurePair {
  /** 0-based positions into `sequence`. */
  i: number;
  j: number;
  /** Base-pair probability or covariation support, 0..1, when known. */
  score?: number;
}

export interface RNAStructureArtifact extends ArtifactBase {
  type: "rna_structure";
  name?: string;
  sequence: string;
  pairs: StructurePair[];
  /** The dot-bracket string, kept for copy/paste and for re-parsing. */
  notation?: string;
  /** Free energies, provider, algorithm: provenance worth showing verbatim. */
  metrics: StructureMetric[];
  /** Set when the producer's data is not renderable as given — an unbalanced
   *  structure string, for instance. Shown instead of a broken diagram. */
  problem?: string;
}

export interface StructureMetric {
  label: string;
  value: string;
  /** Present when the value is approximate (a beam width, a cutoff). */
  note?: string;
}

// --- research ---------------------------------------------------------------

export type ResearchKind = "paper" | "repository";

/**
 * One hit, already flattened for display. Producers do the interpreting — a
 * paper presenter and a repository presenter both emit this — so the card
 * component stays generic and a third kind needs no new component.
 */
export interface ResearchItem {
  id: string;
  title: string;
  /** Authors, owner, or venue line. */
  subtitle?: string;
  /** A stable identifier to show: DOI, arXiv id, PMID, owner handle. */
  identifier?: string;
  date?: string;
  summary?: string;
  url?: string;
  /** Short tags: source, language, access status. */
  badges: string[];
  /** Numeric highlights: citations, stars. */
  stats: { label: string; value: string }[];
}

export interface ResearchArtifact extends ArtifactBase {
  type: "research.paper" | "research.repository";
  kind: ResearchKind;
  query?: string;
  items: ResearchItem[];
  /** Non-fatal problems from the search itself, e.g. one index erroring. */
  notes?: string[];
}

// --- table ------------------------------------------------------------------

export type CellValue = string | number | boolean | null;

export interface TableColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export interface TableArtifact extends ArtifactBase {
  type: "table";
  columns: TableColumn[];
  rows: Record<string, CellValue>[];
  /** How many rows were dropped to keep the DOM bounded. */
  droppedRows?: number;
  /** Render as a field list instead of a grid (single-record results). */
  keyValue?: boolean;
}

// --- plot -------------------------------------------------------------------

export interface PlotSeries {
  name: string;
  points: [number, number][];
  /** CSS colour; falls back to the theme's chart ramp when absent. */
  color?: string;
}

export interface PlotArtifact extends ArtifactBase {
  type: "plot";
  series: PlotSeries[];
  xLabel?: string;
  yLabel?: string;
}

// --- experiment -------------------------------------------------------------

export type ProducedFileKind = "data" | "table" | "sequence" | "image" | "text";

/**
 * One file an experiment wrote. `content` is the inlined text, or a `data:` URI
 * for an image; absent when the harness judged it too large (`truncated`).
 */
export interface ProducedFile {
  name: string;
  kind: ProducedFileKind;
  size: number;
  content?: string;
  truncated?: boolean;
}

/**
 * An agent-authored analysis the harness ran. This is *computed evidence*, kept
 * deliberately distinct from the agent's prose interpretation in the transcript:
 * the card shows the exact code, its streams, and the files it produced, so a
 * reader can see how a number was generated rather than take it on faith.
 */
export interface ExperimentArtifact extends ArtifactBase {
  type: "experiment";
  /** The exact Python that ran. */
  code: string;
  stdout: string;
  stderr: string;
  /** Process exit code, or null if killed on its deadline. */
  exitCode: number | null;
  timedOut: boolean;
  elapsedMs: number;
  /** Interpreter/provider that ran the code. */
  provider: string;
  /** SHA-256 of the exact code that ran. */
  codeSha256?: string;
  /** Interpreter version, when the managed experiment env ran it. */
  pythonVersion?: string;
  /** Hash of the env's resolved packages, when the managed env ran it. */
  depsHash?: string;
  files: ProducedFile[];
}

// --- guards -----------------------------------------------------------------

/**
 * Defensive only. Producers are in this codebase, so a malformed artifact
 * should be impossible; this exists so a bad projection degrades to "dropped"
 * instead of crashing a render deep in the tree.
 */
export function isArtifact(value: unknown): value is Artifact {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Partial<ArtifactBase>;
  return (
    typeof a.id === "string" &&
    typeof a.type === "string" &&
    typeof a.title === "string" &&
    typeof a.createdAt === "number" &&
    (ARTIFACT_TYPES as readonly string[]).includes(a.type)
  );
}
