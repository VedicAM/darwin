/**
 * Sequence and structure parsing.
 *
 * Kept free of React and of the artifact model so the projections in
 * `artifacts/project.ts` and the views can share one implementation, and so the
 * parsing rules are testable in isolation.
 *
 * Two properties are load-bearing:
 *
 *  - **Residues and dot-bracket are separable.** A ViennaRNA `.ct` file puts the
 *    structure on the line after the sequence, and a multi-line FASTA would
 *    otherwise concatenate the two into one invalid string. Residue letters and
 *    bracket characters are therefore split apart and only rejoined when their
 *    lengths agree, which is what makes the pair (sequence, structure)
 *    recoverable from a single blob of text.
 *  - **Prose never parses as sequence.** Every entry point requires either a `>`
 *    header or an alphabet-clean line, so a tool result that is an explanation
 *    rather than data produces nothing instead of a garbage sequence.
 */

/** Characters that mean "no residue here" in an aligned row. */
export const GAP_CHARS = "-.~";

const RESIDUES = new Set(["A", "C", "G", "T", "U", "N", "X", "*"]);
/** Bracket-ish characters that can appear in a structure string. */
const NOTATION_CHARS = /[^()[\]{}<>,.:]/g;

export function isResidue(char: string): boolean {
  return RESIDUES.has(char);
}

export function isGap(char: string): boolean {
  return GAP_CHARS.includes(char);
}

/** Fraction of G+C over unambiguous bases. Ambiguous and gap columns are
 *  excluded from both numerator and denominator, so a mostly-gapped row does
 *  not report a misleadingly high or low GC. */
export function gcContent(sequence: string): number {
  let gc = 0;
  let total = 0;
  for (const char of sequence) {
    if (char === "G" || char === "C") {
      gc += 1;
      total += 1;
    } else if (char === "A" || char === "T" || char === "U") {
      total += 1;
    }
  }
  return total === 0 ? 0 : gc / total;
}

export function composition(sequence: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const char of sequence) counts[char] = (counts[char] ?? 0) + 1;
  return counts;
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * djb2, for identity rather than security: a locally produced artifact needs an
 * id that is stable for the same input, so re-running a fold on the same
 * sequence replaces its own structure instead of stacking a second one up.
 */
export function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** A record before it is turned into a `SequenceRecord`. */
export interface RawRecord {
  name: string;
  description?: string;
  sequence: string;
  notation?: string;
}

/**
 * Split one record's body into residues and a possible dot-bracket string.
 * The notation is only kept when it is the same length as the sequence: that
 * length agreement is what distinguishes a real structure line from
 * parentheses that happened to appear in a FASTA description.
 */
function splitBody(body: string): { sequence: string; notation?: string } {
  const letters = body.toUpperCase().replace(/[^A-Z*]/g, "");
  const sequence = letters.replace(/[^ACGTUNX*]/g, "");
  if (sequence.length === 0) return { sequence: "" };

  const notation = body.toUpperCase().replace(NOTATION_CHARS, "");
  const usable =
    notation.length === sequence.length &&
    /[()[\]{}<>]/.test(notation) &&
    /^[()[\]{}<>,.:]*$/.test(notation);
  return { sequence, notation: usable ? notation : undefined };
}

/** FASTA, with multi-line bodies and an optional trailing structure line. */
export function parseFasta(text: string): RawRecord[] | null {
  const lines = text.split(/\r?\n/);
  const records: RawRecord[] = [];
  let current: { name: string; description?: string; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const { sequence, notation } = splitBody(current.body.join(""));
    if (sequence.length > 0) {
      records.push({
        name: current.name,
        description: current.description,
        sequence,
        notation,
      });
    }
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith(">")) {
      flush();
      const header = line.slice(1).trim();
      if (header.length === 0) continue;
      const split = header.split(/\s+/, 2);
      current = { name: split[0], description: split[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return records.length > 0 ? records : null;
}

/**
 * A bare sequence with no `>` header: one line, alphabet clean, long enough not
 * to be an English word or a codon-by-accident. Used as a fallback only, so a
 * FASTA is never misread by it.
 */
export function parseBareSequence(text: string): RawRecord[] | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line || line.length < 8) return null;
  const upper = line.toUpperCase();
  if (!/^[ACGTUN]+$/.test(upper)) return null;
  return [{ name: "sequence", sequence: upper }];
}

export interface AlignedTable {
  rows: RawRecord[];
  width: number;
  format: string;
}

/** `name<whitespace>gapped residues` per line: MAFFT's plain and RISEO output. */
function parseNamedRows(lines: string[]): RawRecord[] | null {
  const rows: RawRecord[] = [];
  for (const line of lines) {
    const match = /^(\S+)[ \t]{1,}([A-Za-z\-_.~*]+)[ \t]*$/.exec(line);
    if (!match) continue;
    rows.push({ name: match[1], sequence: match[2].toUpperCase() });
  }
  if (rows.length < 2) return null;
  return rows;
}

/** CLUSTAL: a header, blank separator lines, then `name  residues` blocks. */
function parseClustal(lines: string[]): RawRecord[] | null {
  if (!/^CLUSTAL/i.test(lines[0] ?? "")) return null;
  const rows: RawRecord[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) continue;
    const match = /^(\S+)[ \t]+([A-Za-z\-_.~*]+)$/.exec(line);
    if (!match) continue;
    const existing = rows.find((r) => r.name === match[1]);
    if (existing) existing.sequence += match[2].toUpperCase();
    else rows.push({ name: match[1], sequence: match[2].toUpperCase() });
  }
  return rows.length >= 2 ? rows : null;
}

/**
 * Any of the aligned text formats, normalised to equal-width gapped rows.
 *
 * Alignment is *not* the same as "several sequences": it requires equal widths
 * and at least one gap, so an unaligned FASTA of the same length is still read
 * as a plain sequence collection.
 */
export function parseAlignment(text: string): AlignedTable | null {
  const lines = text.split(/\r?\n/);
  let rows = parseClustal(lines);
  let format = "clustal";
  if (!rows) {
    const fasta = parseFasta(text);
    if (fasta) {
      rows = fasta;
      format = "fasta";
    }
  }
  if (!rows) {
    rows = parseNamedRows(lines);
    format = "tab";
  }
  if (!rows || rows.length < 2) return null;

  const width = rows[0].sequence.length;
  if (width === 0 || rows.some((r) => r.sequence.length !== width)) return null;
  if (!rows.some((r) => [...r.sequence].some(isGap))) return null;
  return { rows, width, format };
}

/**
 * Per-column conservation: the most common non-gap residue's share of the
 * column. Positional, not a substitution-matrix score, so it answers "is this
 * column pinned?" rather than "is this substitution plausible?".
 */
export function columnConservation(rows: string[], width: number): Float32Array {
  const out = new Float32Array(width);
  for (let col = 0; col < width; col += 1) {
    const counts = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      const char = row[col];
      if (char === undefined || isGap(char)) continue;
      counts.set(char, (counts.get(char) ?? 0) + 1);
      total += 1;
    }
    if (total === 0) continue;
    let best = 0;
    for (const count of counts.values()) if (count > best) best = count;
    out[col] = best / total;
  }
  return out;
}

export interface ParsedStructure {
  pairs: [number, number][];
  /** Unmatched brackets, and where. A malformed structure is reported rather
   *  than silently drawn as a hairpin. */
  error?: string;
}

/** Dot-bracket to base pairs, honouring bracket types so `([)]` is rejected. */
export function parseStructure(notation: string): ParsedStructure {
  const pairs: [number, number][] = [];
  const open: { char: string; index: number }[] = [];
  const matching: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

  for (let i = 0; i < notation.length; i += 1) {
    const char = notation[i];
    if (char in matching) {
      open.push({ char, index: i });
    } else if (char === ")" || char === "]" || char === "}" || char === ">") {
      const top = open.pop();
      if (!top) return { pairs, error: `unmatched ${char} at position ${i + 1}` };
      if (matching[top.char] !== char) {
        return {
          pairs,
          error: `${top.char} at position ${top.index + 1} closed by ${char} at position ${i + 1}`,
        };
      }
      pairs.push([top.index, i]);
    }
  }
  if (open.length > 0) {
    return { pairs, error: `${open.length} unclosed bracket(s), first at position ${open[0].index + 1}` };
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return { pairs };
}

/** A string is a structure if it is only bracket characters and has a pair in
 *  it. Prose fails on the first test, a sequence on the second. */
export function looksLikeStructure(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  if (!/^[()[\]{}<>,.:]+$/.test(trimmed)) return false;
  return /[()[\]{}<>]/.test(trimmed);
}
