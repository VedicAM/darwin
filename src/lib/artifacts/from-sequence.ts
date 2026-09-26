/**
 * Build workspace artifacts from raw sequence text (a dropped FASTA file).
 *
 * This mirrors what the projectors in `project.ts` produce from a tool result,
 * so a dropped file and a tool-emitted sequence render through the exact same
 * views. It is a separate entry point only because a file drop is not a tool
 * call — there is no `ToolObservation` to project.
 */

import type {
  AlignmentArtifact,
  AlignmentRow,
  Artifact,
  SequenceArtifact,
  SequenceRecord,
} from "@/lib/artifacts/types";
import {
  columnConservation,
  composition,
  gcContent,
  parseAlignment,
  parseBareSequence,
  parseFasta,
  shortHash,
  type RawRecord,
} from "@/lib/sequence";

/** What a dropped file resolved to, so the caller can both show it and tell
 *  the agent about it. */
export interface DroppedSequences {
  artifact: Artifact;
  /** The parsed records, for composing a prompt snippet. */
  records: RawRecord[];
  /** True when the file parsed as a gapped alignment rather than plain records. */
  aligned: boolean;
}

function sequenceRecord(raw: RawRecord, index: number): SequenceRecord {
  return {
    id: `${raw.name || "seq"}-${index}`,
    name: raw.name || `sequence ${index + 1}`,
    description: raw.description,
    sequence: raw.sequence,
    length: raw.sequence.length,
    gc: gcContent(raw.sequence),
    composition: composition(raw.sequence),
  };
}

/**
 * Parse `text` (from a file named `filename`) into a sequence or alignment
 * artifact, or `null` if it is not sequence data.
 *
 * An alignment is tried first: a gapped, equal-width FASTA is an alignment, and
 * only an unaligned collection falls through to the sequence view.
 */
export function sequencesFromText(filename: string, text: string): DroppedSequences | null {
  const idBase = `drop:${shortHash(`${filename}:${text}`)}`;
  const title = filename || "Dropped sequences";
  const now = Date.now();

  const alignment = parseAlignment(text);
  if (alignment) {
    const rows: AlignmentRow[] = alignment.rows.map((r, i) => ({
      id: `${r.name || "row"}-${i}`,
      name: r.name || `row ${i + 1}`,
      description: r.description,
      row: r.sequence,
    }));
    const conservation = Array.from(
      columnConservation(rows.map((r) => r.row), alignment.width),
    );
    const artifact: AlignmentArtifact = {
      id: `${idBase}:alignment`,
      type: "alignment",
      title,
      createdAt: now,
      rows,
      width: alignment.width,
      format: alignment.format,
      conservation,
    };
    return { artifact, records: alignment.rows, aligned: true };
  }

  const parsed = parseFasta(text) ?? parseBareSequence(text);
  if (!parsed) return null;

  // A single dot-bracket structure alongside a single record is worth carrying
  // through to the sequence view, same as the projector does.
  const structure =
    parsed.length === 1 && parsed[0].notation ? parsed[0].notation : undefined;

  const artifact: SequenceArtifact = {
    id: `${idBase}:sequence`,
    type: "sequence",
    title,
    createdAt: now,
    records: parsed.map(sequenceRecord),
    structure,
  };
  return { artifact, records: parsed, aligned: false };
}

/** Filenames a FASTA drop accepts. Kept liberal — `.txt` is included because
 *  exported sequences often land there — but the content still has to parse. */
export function looksLikeFasta(filename: string): boolean {
  return /\.(fa|fasta|fna|ffn|faa|frn|aln|clustal|txt)$/i.test(filename);
}
