/**
 * Turning a tool result into artifacts.
 *
 * This is the only place that knows what a *result* looks like. Components know
 * only about `artifact.type`, so a new tool becomes visible in the workspace by
 * emitting a shape this module recognises — no UI change.
 *
 * Recognition is by shape, not by tool name. A `papers` array from one search
 * and an `items` array from another both become research artifacts, and a tool
 * that nobody has heard of still works as long as it returns a FASTA or a table
 * of objects. That is deliberate: tool names are an accident of implementation,
 * and hard-coding them here would put every future tool behind a UI change.
 *
 * Projectors are pure and deterministic. A projection is keyed by the tool's
 * `toolCallId`, so re-projecting the same result replaces its artifact rather
 * than duplicating it.
 */

import type {
  AlignmentArtifact,
  AlignmentRow,
  Artifact,
  CellValue,
  ExperimentArtifact,
  PlotArtifact,
  ProducedFile,
  ProducedFileKind,
  PlotSeries,
  ResearchArtifact,
  ResearchItem,
  ResearchKind,
  RNAStructureArtifact,
  SequenceArtifact,
  SequenceRecord,
  StructureMetric,
  StructurePair,
  TableArtifact,
  TableColumn,
} from "@/lib/artifacts/types";
import {
  columnConservation,
  composition,
  gcContent,
  looksLikeStructure,
  parseAlignment,
  parseBareSequence,
  parseFasta,
  parseStructure,
  type RawRecord,
} from "@/lib/sequence";
import type { FoldResult } from "@/lib/harness";
import { sequencesFromText } from "@/lib/artifacts/from-sequence";

/** One finished tool call, plus the clock reading taken when it landed. */
export interface ToolObservation {
  callId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError: boolean;
  now: number;
}

interface TextBlob {
  key: string;
  text: string;
}

interface ProjectContext {
  obs: ToolObservation;
  /** Records already claimed by an earlier projector, so one result does not
   *  turn into three artifacts describing the same object. */
  consumed: Set<object>;
  blobs: TextBlob[];
  roots: Record<string, unknown>[];
}

/** Bounds on the deep walk. A tool result is not a file browser: past these,
 *  the walk is truncated rather than allowed to stall the UI thread. */
const MAX_BLOB_NODES = 4000;
const MAX_BLOB_CHARS = 2_000_000;
const MAX_CANDIDATE_ARRAYS = 8;
/** Per-array cap. Anything past this is counted, not shown, and the count is
 *  reported on the artifact — a silently truncated result is a wrong result. */
const MAX_ITEMS_PER_ARRAY = 200;
const MAX_TABLE_ROWS = 500;
const MAX_TABLE_COLUMNS = 14;
const MAX_SUMMARY = 700;
const MAX_SUBTITLE = 180;

// --- small helpers ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The file a call touched, when it touched one. Used for artifact titles so
 *  a workspace full of `read` results is still navigable. */
function sourceName(obs: ToolObservation): string | undefined {
  const args = obs.args;
  if (!args) return undefined;
  for (const key of ["path", "file_path", "filepath", "file", "filename"]) {
    const value = asString(args[key]);
    if (value) return basename(value);
  }
  return undefined;
}

function title(obs: ToolObservation, fallback: string): string {
  return sourceName(obs) ?? fallback;
}

/** Records worth scanning inside a result. Pi tools wrap their payload in
 *  `result.details` (that is the extension contract) and some nest it again
 *  under `result`, so both are treated as roots. */
function rootsOf(result: unknown): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 3 || !isRecord(value)) return;
    roots.push(value);
    for (const key of ["result", "data", "payload", "output"]) visit(value[key], depth + 1);
  };
  visit(result, 0);
  return roots;
}

function collectStrings(
  value: unknown,
  key: string,
  out: TextBlob[],
  budget: { nodes: number; chars: number },
): void {
  if (budget.nodes >= MAX_BLOB_NODES || budget.chars >= MAX_BLOB_CHARS) return;
  budget.nodes += 1;
  if (typeof value === "string") {
    budget.chars += value.length;
    if (value.trim().length > 0) out.push({ key, text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, key, out, budget);
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      collectStrings(child, childKey, out, budget);
    }
  }
}

/**
 * Every string reachable in the result, plus the call's own arguments. A
 * sequence handed to a tool as an argument is just as much a result as one read
 * back out of a file.
 */
function collectBlobs(obs: ToolObservation): TextBlob[] {
  const out: TextBlob[] = [];
  const budget = { nodes: 0, chars: 0 };
  collectStrings(obs.result, "result", out, budget);
  if (obs.args) collectStrings(obs.args, "arg", out, budget);
  return out;
}

function artifactId(obs: ToolObservation, suffix: string): string {
  return `call:${obs.callId}:${suffix}`;
}

function source(obs: ToolObservation) {
  return { toolCallId: obs.callId, toolName: obs.toolName };
}

// --- research ---------------------------------------------------------------

interface CandidateArray {
  path: string;
  items: Record<string, unknown>[];
  /** Length before the per-array cap, so truncation can be reported. */
  total: number;
}

/** Arrays of objects anywhere in the payload, which is where every search API
 *  puts its hits. Bounded so one enormous array cannot dominate. */
function candidateArrays(roots: Record<string, unknown>[]): CandidateArray[] {
  const found: CandidateArray[] = [];
  const seen = new Set<object>();
  for (const root of roots) {
    for (const [key, value] of Object.entries(root)) {
      if (found.length >= MAX_CANDIDATE_ARRAYS) break;
      if (!Array.isArray(value) || value.length === 0) continue;
      const records = value.filter(isRecord);
      if (records.length === 0 || seen.has(records[0])) continue;
      seen.add(records[0]);
      found.push({ path: key, items: records.slice(0, MAX_ITEMS_PER_ARRAY), total: value.length });
    }
  }
  return found;
}

const PAPER_MARKERS = [
  "doi",
  "pmid",
  "pmcid",
  "arxiv_id",
  "arxivId",
  "abstract",
  "authors",
  "venue",
  "published",
  "journal",
];

const PAPER_SOURCES = new Set(["arxiv", "pmc", "pubmed", "medrxiv", "biorxiv", "europepmc"]);

function looksLikePaper(item: Record<string, unknown>): boolean {
  if (!asString(item.title)) return false;
  if (PAPER_MARKERS.some((marker) => item[marker] !== undefined)) return true;
  const source = asString(item.source)?.toLowerCase();
  if (source && PAPER_SOURCES.has(source)) return true;
  const url = asString(item.url) ?? asString(item.abs_url) ?? "";
  return /arxiv|doi\.org|pubmed|pmc\.ncbi|europepmc/i.test(url);
}

function authorLine(item: Record<string, unknown>): string | undefined {
  const authors = item.authors;
  if (typeof authors === "string") return truncate(authors, MAX_SUBTITLE);
  if (Array.isArray(authors)) {
    const names = authors
      .map((a) => (typeof a === "string" ? a : asString(isRecord(a) ? a.name : undefined)))
      .filter((a): a is string => Boolean(a));
    if (names.length > 0) {
      const shown = names.slice(0, 4).join(", ");
      return names.length > 4 ? `${shown}, +${names.length - 4} more` : shown;
    }
  }
  return undefined;
}

function presentPaper(item: Record<string, unknown>, index: number): ResearchItem {
  const arxivId = asString(item.arxiv_id) ?? asString(item.arxivId);
  const doi = asString(item.doi);
  const identifier =
    arxivId !== undefined
      ? `arXiv:${arxivId}`
      : (doi ?? asString(item.pmid) ?? asString(item.pmcid) ?? asString(item.venue));
  const stats: ResearchItem["stats"] = [];
  const citedBy = asNumber(item.citedBy) ?? asNumber(item.cited_by);
  if (citedBy !== undefined) stats.push({ label: "citations", value: formatCount(citedBy) });

  const badges: string[] = [];
  const source = asString(item.source);
  if (source) badges.push(source.toUpperCase());
  const venue = asString(item.venue) ?? asString(item.journal);
  if (venue) badges.push(venue);
  if (item.openAccess === true) badges.push("open access");

  return {
    id: `paper-${index}-${arxivId ?? doi ?? asString(item.title)?.slice(0, 40) ?? index}`,
    title: asString(item.title) ?? "Untitled",
    subtitle: authorLine(item),
    identifier,
    date: asString(item.published) ?? asString(item.date) ?? asString(item.updated),
    summary: truncate(asString(item.abstract) ?? asString(item.summary) ?? "", MAX_SUMMARY) || undefined,
    url:
      asString(item.url) ??
      asString(item.abs_url) ??
      asString(item.link) ??
      (arxivId ? `https://arxiv.org/abs/${arxivId}` : doi ? `https://doi.org/${doi}` : undefined),
    badges,
    stats,
  };
}

function ownerHandle(item: Record<string, unknown>): string | undefined {
  const owner = item.owner;
  if (isRecord(owner)) return asString(owner.login) ?? asString(owner.name);
  return asString(owner);
}

function looksLikeRepository(item: Record<string, unknown>): boolean {
  if (asString(item.full_name) ?? asString(item.fullName)) return true;
  if (item.owner !== undefined && asString(item.name) !== undefined) return true;
  if (item.stargazers_count !== undefined || item.stars !== undefined) return true;
  return /github\.com/.test(asString(item.html_url) ?? asString(item.url) ?? "");
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function presentRepository(item: Record<string, unknown>, index: number): ResearchItem {
  const fullName = asString(item.full_name) ?? asString(item.fullName);
  const name = fullName ?? asString(item.name) ?? "untitled";
  const badges: string[] = [];
  const language = asString(item.language);
  if (language) badges.push(language);
  const license = item.license;
  if (typeof license === "string") badges.push(license);
  else if (isRecord(license)) {
    const spdx = asString(license.spdx_id) ?? asString(license.name);
    if (spdx && spdx !== "NOASSERTION") badges.push(spdx);
  }
  if (Array.isArray(item.topics)) {
    for (const topic of item.topics.slice(0, 2)) {
      const text = asString(topic);
      if (text) badges.push(text);
    }
  }

  const stats: ResearchItem["stats"] = [];
  const stars = asNumber(item.stargazers_count) ?? asNumber(item.stars);
  if (stars !== undefined) stats.push({ label: "stars", value: formatCount(stars) });
  const forks = asNumber(item.forks_count) ?? asNumber(item.forks);
  if (forks !== undefined) stats.push({ label: "forks", value: formatCount(forks) });
  const issues = asNumber(item.open_issues_count) ?? asNumber(item.open_issues);
  if (issues !== undefined) stats.push({ label: "issues", value: formatCount(issues) });

  return {
    id: `repo-${index}-${name}`,
    title: name,
    subtitle: truncate(asString(item.description) ?? "", MAX_SUBTITLE) || undefined,
    identifier: ownerHandle(item),
    date: asString(item.pushed_at) ?? asString(item.updated_at),
    badges,
    stats,
    url:
      asString(item.html_url) ??
      asString(item.url) ??
      (asString(item.full_name) ? `https://github.com/${asString(item.full_name)}` : undefined),
  };
}

function researchProjector(ctx: ProjectContext): Artifact[] {
  const arrays = candidateArrays(ctx.roots);
  if (arrays.length === 0) return [];

  const papers: ResearchItem[] = [];
  const repos: ResearchItem[] = [];
  const notes: string[] = [];
  let query: string | undefined;
  let dropped = 0;
  let truncated = 0;

  for (const array of arrays) {
    if (array.total > array.items.length) truncated += array.total - array.items.length;
    for (const item of array.items) {
      if (looksLikePaper(item)) papers.push(presentPaper(item, papers.length));
      else if (looksLikeRepository(item)) repos.push(presentRepository(item, repos.length));
      else dropped += 1;
    }
  }
  if (papers.length === 0 && repos.length === 0) return [];

  for (const root of ctx.roots) {
    query ??= asString(root.query) ?? asString(root.q) ?? asString(root.term);
    const errors = root.errors;
    if (Array.isArray(errors)) {
      for (const entry of errors.slice(0, 4)) {
        const text = typeof entry === "string" ? entry : asString(isRecord(entry) ? entry.message : undefined);
        if (text) notes.push(truncate(text, 200));
      }
    }
  }
  if (dropped > 0) notes.push(`${dropped} result(s) were neither a paper nor a repository and were not shown.`);
  if (truncated > 0) notes.push(`${truncated} further result(s) were not shown.`);

  const make = (kind: ResearchKind, items: ResearchItem[]): Artifact => {
    const suffix = kind === "paper" ? "papers" : "repos";
    const artifact: ResearchArtifact = {
      id: artifactId(ctx.obs, suffix),
      type: kind === "paper" ? "research.paper" : "research.repository",
      title: title(
        ctx.obs,
        kind === "paper"
          ? `${items.length} paper${items.length === 1 ? "" : "s"}`
          : `${items.length} repositor${items.length === 1 ? "y" : "ies"}`,
      ),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      kind,
      query,
      items,
      notes: notes.length > 0 ? notes : undefined,
    };
    return artifact;
  };

  const out: Artifact[] = [];
  if (papers.length > 0) out.push(make("paper", papers));
  if (repos.length > 0) out.push(make("repository", repos));
  return out;
}

// --- rna structure ----------------------------------------------------------

function metricList(record: Record<string, unknown>): StructureMetric[] {
  const metrics: StructureMetric[] = [];
  const push = (label: string, value: string | undefined, note?: string) => {
    if (value !== undefined && value.length > 0) metrics.push({ label, value, note });
  };
  const mfe = asNumber(record.mfe) ?? asNumber(record.minimum_free_energy) ?? asNumber(record.free_energy);
  if (mfe !== undefined) push("MFE", `${mfe.toFixed(2)} kcal/mol`);
  const ensemble = asNumber(record.ensemble_free_energy) ?? asNumber(record.ensemble_free_energy_kcal);
  if (ensemble !== undefined) push("Ensemble ΔG", `${ensemble.toFixed(2)} kcal/mol`);
  push("Provider", asString(record.provider));
  push("Algorithm", asString(record.algorithm));
  push("Energy model", asString(record.energy_model) ?? asString(record.energyModel));
  const elapsed = asNumber(record.elapsed_ms) ?? asNumber(record.elapsedMs);
  if (elapsed !== undefined) push("Elapsed", `${elapsed.toFixed(0)} ms`);
  const cutoff = asNumber(record.cutoff);
  if (cutoff !== undefined) push("Probability cutoff", cutoff.toExponential(1), "approximate");
  const beamsize = asNumber(record.beamsize);
  if (beamsize !== undefined) push("Beam width", String(beamsize), "approximate");
  return metrics;
}

/** Provenance the harness records, flattened. A number without these is still
 *  displayable, but these are what make it auditable, so they are surfaced
 *  rather than buried. */
function fingerprintMetrics(record: Record<string, unknown>): StructureMetric[] {
  const fingerprint = record.fingerprint;
  if (!isRecord(fingerprint)) return [];
  const metrics: StructureMetric[] = [];
  const short = (value: string | undefined) => (value ? `${value.slice(0, 12)}…` : undefined);
  const tool = asString(fingerprint.tool);
  if (tool) {
    const version = asString(fingerprint.tool_version);
    metrics.push({ label: "Tool", value: version ? `${tool}@${version}` : tool });
  }
  metrics.push(
    { label: "Artifact sha256", value: short(asString(fingerprint.artifact_sha256)) ?? "" },
    { label: "Adapter sha256", value: short(asString(fingerprint.adapter_sha256)) ?? "" },
  );
  const python = asString(fingerprint.python_version);
  if (python) metrics.push({ label: "Python", value: python });
  const rev = asString(fingerprint.harness_rev);
  if (rev) metrics.push({ label: "Harness rev", value: rev });
  return metrics.filter((m) => m.value.length > 0);
}

function pairsFromList(value: unknown): StructurePair[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pairs: StructurePair[] = [];
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const i = asNumber(entry[0]);
      const j = asNumber(entry[1]);
      if (i === undefined || j === undefined) continue;
      pairs.push({ i, j, score: asNumber(entry[2]) });
      continue;
    }
    if (!isRecord(entry)) continue;
    const i = asNumber(entry.i) ?? asNumber(entry.p1) ?? asNumber(entry.a);
    const j = asNumber(entry.j) ?? asNumber(entry.p2) ?? asNumber(entry.b);
    if (i === undefined || j === undefined) continue;
    pairs.push({
      i,
      j,
      score: asNumber(entry.probability) ?? asNumber(entry.score) ?? asNumber(entry.prob),
    });
  }
  return pairs;
}

const SEQUENCE_KEYS = ["sequence", "seq", "target_sequence", "rna"];
const NOTATION_KEYS = [
  "structure",
  "dot_bracket",
  "dotbracket",
  "dot-bracket",
  "secondary_structure",
  "structure_string",
  "vienna",
];

function sequenceOf(record: Record<string, unknown>): string | undefined {
  for (const key of SEQUENCE_KEYS) {
    const value = asString(record[key]);
    if (value && /^[ACGUTUNX*-]+$/i.test(value)) return value.toUpperCase().replace(/\*/g, "N");
  }
  return undefined;
}

function notationOf(record: Record<string, unknown>): string | undefined {
  for (const key of NOTATION_KEYS) {
    const value = asString(record[key]);
    if (value && looksLikeStructure(value)) return value.trim();
  }
  return undefined;
}

function structureProjector(ctx: ProjectContext): Artifact[] {
  const out: Artifact[] = [];

  for (const root of ctx.roots) {
    if (ctx.consumed.has(root)) continue;
    const sequence = sequenceOf(root);
    if (!sequence) continue;

    const notation = notationOf(root);
    const listed = pairsFromList(root.base_pairs) ?? pairsFromList(root.pairs);
    if (!notation && !listed) continue;
    ctx.consumed.add(root);

    const pairs: StructurePair[] = [];
    let problem: string | undefined;
    let resolved: string | undefined;

    if (listed && listed.length > 0) {
      pairs.push(...listed);
    } else if (notation) {
      const parsed = parseStructure(notation);
      pairs.push(...parsed.pairs.map(([i, j]) => ({ i, j })));
      problem = parsed.error;
      resolved = notation;
    }
    if (pairs.length === 0 && !problem) continue;

    const metrics = [...metricList(root), ...fingerprintMetrics(root)];
    const artifact: RNAStructureArtifact = {
      id: artifactId(ctx.obs, "structure"),
      type: "rna_structure",
      title: title(ctx.obs, `Secondary structure · ${sequence.length} nt`),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      name: asString(root.name) ?? asString(root.id) ?? sourceName(ctx.obs),
      sequence,
      pairs,
      notation: resolved,
      metrics,
      problem,
    };
    out.push(artifact);
  }

  // A `.ct` file, or a result that is text rather than JSON: the sequence and
  // the structure arrive as two lines of one blob.
  if (out.length === 0) {
    for (const blob of ctx.blobs) {
      const record = parseFasta(blob.text)?.find((r) => r.notation !== undefined);
      if (!record) continue;
      const parsed = parseStructure(record.notation ?? "");
      const artifact: RNAStructureArtifact = {
        id: artifactId(ctx.obs, "structure"),
        type: "rna_structure",
        title: title(ctx.obs, `Secondary structure · ${record.sequence.length} nt`),
        createdAt: ctx.obs.now,
        source: source(ctx.obs),
        name: record.name,
        sequence: record.sequence,
        pairs: parsed.pairs.map(([i, j]) => ({ i, j })),
        notation: record.notation,
        metrics: [],
        problem: parsed.error,
      };
      out.push(artifact);
      break;
    }
  }
  return out;
}

// --- sequence ---------------------------------------------------------------

function toRecord(raw: RawRecord, index: number): SequenceRecord {
  return {
    id: `rec-${index}-${raw.name}`,
    name: raw.name,
    description: raw.description,
    sequence: raw.sequence,
    length: raw.sequence.length,
    gc: gcContent(raw.sequence),
    composition: composition(raw.sequence),
  };
}

function isAligned(records: RawRecord[]): boolean {
  const width = records[0].sequence.length;
  return records.length > 1 && records.every((r) => r.sequence.length === width);
}

function sequenceProjector(ctx: ProjectContext): Artifact[] {
  for (const blob of ctx.blobs) {
    const parsed = parseFasta(blob.text);
    if (!parsed || parsed.length === 0) continue;
    // Equal-width rows are an alignment; the alignment projector owns those so
    // one file does not appear twice.
    if (isAligned(parsed)) continue;
    if (parseAlignment(blob.text)) continue;

    const records = parsed.map(toRecord);
    const artifact: SequenceArtifact = {
      id: artifactId(ctx.obs, "sequence"),
      type: "sequence",
      title: title(
        ctx.obs,
        records.length === 1
          ? `${records[0].name} · ${records[0].length} nt`
          : `${records.length} sequences`,
      ),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      records,
      structure: parsed[0]?.notation,
    };
    return [artifact];
  }

  // A bare sequence with no header, e.g. the argument of a fold-style call.
  for (const blob of ctx.blobs) {
    const parsed = parseBareSequence(blob.text);
    if (!parsed) continue;
    const records = parsed.map(toRecord);
    const artifact: SequenceArtifact = {
      id: artifactId(ctx.obs, "sequence"),
      type: "sequence",
      title: title(ctx.obs, `${records[0].length} nt`),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      records,
    };
    return [artifact];
  }
  return [];
}

// --- alignment --------------------------------------------------------------

function alignmentProjector(ctx: ProjectContext): Artifact[] {
  for (const blob of ctx.blobs) {
    const aligned = parseAlignment(blob.text);
    if (!aligned) continue;
    const rows: AlignmentRow[] = aligned.rows.map((row, index) => ({
      id: `row-${index}-${row.name}`,
      name: row.name,
      description: row.description,
      row: row.sequence,
    }));
    const conservation = columnConservation(
      rows.map((r) => r.row),
      aligned.width,
    );
    const artifact: AlignmentArtifact = {
      id: artifactId(ctx.obs, "alignment"),
      type: "alignment",
      title: title(ctx.obs, `${rows.length} × ${aligned.width}`),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      rows,
      width: aligned.width,
      format: aligned.format,
      conservation: Array.from(conservation),
    };
    return [artifact];
  }
  return [];
}

// --- table ------------------------------------------------------------------

const MAX_CELL_CHARS = 240;

function cellOf(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? truncate(value, MAX_CELL_CHARS) : value;
  }
  try {
    return truncate(JSON.stringify(value), MAX_CELL_CHARS);
  } catch {
    return null;
  }
}

function tableProjector(ctx: ProjectContext): Artifact[] {
  for (const array of candidateArrays(ctx.roots)) {
    if (array.items.some((item) => looksLikePaper(item) || looksLikeRepository(item))) continue;

    const keys: string[] = [];
    for (const item of array.items) {
      for (const key of Object.keys(item)) {
        if (!keys.includes(key)) keys.push(key);
        if (keys.length >= MAX_TABLE_COLUMNS) break;
      }
      if (keys.length >= MAX_TABLE_COLUMNS) break;
    }
    if (keys.length === 0) continue;

    const numeric = new Set<string>();
    for (const key of keys) {
      const sample = array.items.find((item) => item[key] !== null && item[key] !== undefined)?.[key];
      if (typeof sample === "number") numeric.add(key);
    }

    const columns: TableColumn[] = keys.map((key) => ({
      key,
      label: humanise(key),
      numeric: numeric.has(key),
    }));
    const rows = array.items.slice(0, MAX_TABLE_ROWS).map((item) => {
      const row: Record<string, CellValue> = {};
      for (const key of keys) row[key] = cellOf(item[key]);
      return row;
    });

    const artifact: TableArtifact = {
      id: artifactId(ctx.obs, "table"),
      type: "table",
      title: title(ctx.obs, `${rows.length} row${rows.length === 1 ? "" : "s"}`),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      columns,
      rows,
      droppedRows: Math.max(0, array.total - array.items.length),
    };
    return [artifact];
  }

  // A single flat record: a field list reads better than a one-row grid.
  for (const root of ctx.roots) {
    if (ctx.consumed.has(root)) continue;
    const keys = Object.keys(root);
    if (keys.length === 0 || keys.length > 24) continue;
    const values = keys.map((key) => root[key]);
    if (!values.every((v) => v === null || typeof v !== "object")) continue;
    ctx.consumed.add(root);
    const columns: TableColumn[] = keys.map((key) => ({
      key,
      label: humanise(key),
      numeric: typeof root[key] === "number",
    }));
    const row: Record<string, CellValue> = {};
    for (const key of keys) row[key] = cellOf(root[key]);
    const artifact: TableArtifact = {
      id: artifactId(ctx.obs, "fields"),
      type: "table",
      title: title(ctx.obs, "Result fields"),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      columns,
      rows: [row],
      keyValue: true,
    };
    return [artifact];
  }
  return [];
}

function humanise(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// --- plot -------------------------------------------------------------------

function plotProjector(ctx: ProjectContext): Artifact[] {
  for (const root of ctx.roots) {
    if (ctx.consumed.has(root)) continue;
    const series = plotSeriesOf(root);
    if (!series) continue;
    ctx.consumed.add(root);
    const artifact: PlotArtifact = {
      id: artifactId(ctx.obs, "plot"),
      type: "plot",
      title: title(ctx.obs, series.length === 1 ? series[0].name : "Plot"),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      series,
      xLabel: asString(root.x_label) ?? asString(root.xlabel),
      yLabel: asString(root.y_label) ?? asString(root.ylabel),
    };
    return [artifact];
  }
  return [];
}

function plotSeriesOf(root: Record<string, unknown>): PlotSeries[] | null {
  const out: PlotSeries[] = [];
  const list = root.series;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const name = asString(entry.name) ?? asString(entry.label) ?? `Series ${out.length + 1}`;
      const points = pointsOf(entry);
      if (points.length >= 2) out.push({ name, points, color: asString(entry.color) });
    }
  } else {
    const points = pointsOf(root);
    if (points.length >= 2) out.push({ name: asString(root.name) ?? "value", points });
  }
  return out.length > 0 ? out : null;
}

function pointsOf(record: Record<string, unknown>): [number, number][] {
  const points: [number, number][] = [];
  const list = record.points ?? record.values ?? record.data;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const x = asNumber(entry[0]);
        const y = asNumber(entry[1]);
        if (x !== undefined && y !== undefined) points.push([x, y]);
      } else if (isRecord(entry)) {
        const x = asNumber(entry.x) ?? asNumber(entry.i);
        const y = asNumber(entry.y) ?? asNumber(entry.value) ?? asNumber(entry.v);
        if (x !== undefined && y !== undefined) points.push([x, y]);
      } else {
        const y = asNumber(entry);
        if (y !== undefined) points.push([points.length, y]);
      }
    }
  }
  return points;
}

// --- experiment -------------------------------------------------------------

const PRODUCED_FILE_KINDS = new Set(["data", "table", "sequence", "image", "text"]);

function producedFileOf(value: unknown): ProducedFile | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  const rawKind = asString(value.kind);
  const kind = (rawKind && PRODUCED_FILE_KINDS.has(rawKind) ? rawKind : "text") as ProducedFileKind;
  return {
    name,
    kind,
    size: asNumber(value.size) ?? 0,
    content: asString(value.content),
    truncated: value.truncated === true,
  };
}

/**
 * An experiment result: the harness ran agent-authored code. Recognised by
 * shape — a `produced_files` array alongside `code` and `stdout` strings —
 * rather than by the tool name, so the philosophy of this module holds. The
 * root is consumed so `produced_files` is not also mined into a stray table.
 */
function experimentProjector(ctx: ProjectContext): Artifact[] {
  for (const root of ctx.roots) {
    if (ctx.consumed.has(root)) continue;
    const files = root.produced_files;
    if (!Array.isArray(files)) continue;
    if (typeof root.code !== "string" || typeof root.stdout !== "string") continue;

    ctx.consumed.add(root);
    const produced = files.map(producedFileOf).filter((f): f is ProducedFile => f !== null);
    const artifact: ExperimentArtifact = {
      id: artifactId(ctx.obs, "experiment"),
      type: "experiment",
      title: title(ctx.obs, "Experiment"),
      createdAt: ctx.obs.now,
      source: source(ctx.obs),
      code: root.code,
      stdout: root.stdout,
      stderr: asString(root.stderr) ?? "",
      exitCode: asNumber(root.exit_code) ?? null,
      timedOut: root.timed_out === true,
      elapsedMs: asNumber(root.elapsed_ms) ?? 0,
      provider: asString(root.provider) ?? "unknown",
      codeSha256: asString(root.code_sha256),
      pythonVersion: asString(root.python_version),
      depsHash: asString(root.deps_hash),
      files: produced,
    };

    // A produced sequence/alignment file is worth its own first-class artifact,
    // so an experiment that writes an aligned FASTA renders in the alignment
    // view rather than only as text inside the experiment card. Data/text/image
    // files stay inside the card.
    const derived: Artifact[] = [];
    for (const file of produced) {
      if (file.kind !== "sequence" || !file.content) continue;
      const seq = sequencesFromText(file.name, file.content);
      if (!seq) continue;
      derived.push({
        ...seq.artifact,
        id: `${artifactId(ctx.obs, "file")}:${file.name}`,
        createdAt: ctx.obs.now,
        source: source(ctx.obs),
      });
    }
    return [artifact, ...derived];
  }
  return [];
}

// --- entry point ------------------------------------------------------------

const PROJECTORS: ((ctx: ProjectContext) => Artifact[])[] = [
  experimentProjector,
  researchProjector,
  structureProjector,
  sequenceProjector,
  alignmentProjector,
  tableProjector,
  plotProjector,
];

/**
 * Project one finished tool call into zero or more artifacts.
 *
 * A failed call still projects: an error payload can carry a partial result,
 * and a table of the error fields is more useful than nothing. The failure is
 * recorded on the workflow step, not here.
 */
export function projectArtifacts(obs: ToolObservation): Artifact[] {
  if (obs.result === undefined) return [];
  const ctx: ProjectContext = {
    obs,
    consumed: new Set<object>(),
    blobs: collectBlobs(obs),
    roots: rootsOf(obs.result),
  };
  const out: Artifact[] = [];
  for (const projector of PROJECTORS) {
    for (const artifact of projector(ctx)) {
      // Two projectors can see the same object; first one wins so ids stay
      // unique within a call.
      if (out.some((existing) => existing.id === artifact.id)) continue;
      out.push(artifact);
    }
  }
  return out;
}

/**
 * Wrap a harness fold result as a structure artifact.
 *
 * The same path a projected structure takes, so a fold the user asked for from
 * the panel is indistinguishable from one a tool returned — same renderer, same
 * provenance block, same selection behaviour.
 */
export function structureFromFold(
  result: FoldResult,
  id: string,
  titleText: string,
): RNAStructureArtifact {
  const parsed = parseStructure(result.structure);
  const pairs: StructurePair[] = parsed.pairs.map(([i, j]) => ({ i, j }));
  // Base-pair probabilities layer on top of the MFE structure's pairs. They are
  // the covariation evidence for those pairs, so the score is what the
  // probability field says and nothing else.
  for (const pair of result.base_pairs ?? []) {
    const match = pairs.find((p) => p.i === pair.i && p.j === pair.j);
    if (match) match.score = pair.probability;
  }
  return {
    id,
    type: "rna_structure",
    title: titleText,
    createdAt: Date.now(),
    name: undefined,
    sequence: result.sequence,
    pairs,
    notation: result.structure,
    metrics: [
      ...metricList(result as unknown as Record<string, unknown>),
      ...fingerprintMetrics(result as unknown as Record<string, unknown>),
    ],
    problem: parsed.error,
  };
}
