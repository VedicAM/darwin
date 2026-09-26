/**
 * Layout for RNA secondary-structure diagrams.
 *
 * A deliberately simple model: the backbone is a straight line, every base pair
 * is an arc above it, and a base's height is the number of pairs enclosing it.
 * Because dot-bracket is non-crossing, arcs at the same depth span disjoint
 * intervals and arcs at greater depth sit inside them, so arcs can never
 * cross — the layout needs no crossing-elimination pass.
 *
 * The output is pure geometry so the view can decide how to draw it (and can
 * window it for long sequences) without recomputing anything.
 */

import type { StructurePair } from "@/lib/artifacts/types";

export interface StructureArc {
  i: number;
  j: number;
  /** Both endpoints share a depth, so one row is enough. */
  y: number;
  /** Peak of the arc, in the same units as `y`. Above the endpoints. */
  apex: number;
  score?: number;
}

export interface StructureLayout {
  length: number;
  /** x per base, and its index. */
  pxPerBase: number;
  /** y per nesting level. */
  rowHeight: number;
  /** Enclosing-pair count for every position. */
  depth: Int32Array;
  arcs: StructureArc[];
  /** Deepest enclosing count, so the view knows how many rows to reserve. */
  maxDepth: number;
  /** Bounding box, in px, before any padding. */
  width: number;
  height: number;
  /** Peak score across all pairs, for normalising confidence shading. */
  maxScore: number;
}

/** How far an arc rises above its endpoints, as a fraction of a row. */
const ARC_RISE = 0.78;

export function layoutStructure(
  length: number,
  pairs: StructurePair[],
  pxPerBase: number,
  rowHeight: number,
): StructureLayout {
  const valid = pairs
    .filter((p) => p.i >= 0 && p.j >= 0 && p.i < length && p.j < length && p.i !== p.j)
    .sort((a, b) => a.i - b.i || a.j - b.j);

  const depth = new Int32Array(length);
  const startAt = new Map<number, number>();
  const open: number[] = [];
  let maxDepth = 0;

  for (const pair of valid) {
    // A repeated left index cannot happen in a well-formed structure; taking
    // the innermost keeps the diagram sane if it does.
    startAt.set(pair.i, pair.j);
  }
  for (let i = 0; i < length; i += 1) {
    while (open.length > 0 && open[open.length - 1] < i) open.pop();
    depth[i] = open.length;
    if (depth[i] > maxDepth) maxDepth = depth[i];
    const ends = startAt.get(i);
    if (ends !== undefined) open.push(ends);
  }

  const arcs: StructureArc[] = valid.map((pair) => {
    const y = depth[pair.i] * rowHeight;
    return {
      i: pair.i,
      j: pair.j,
      y,
      apex: y - rowHeight * ARC_RISE,
      score: pair.score,
    };
  });

  const maxScore = arcs.reduce((best, arc) => {
    const s = arc.score;
    return s === undefined || Number.isNaN(s) ? best : Math.max(best, s);
  }, 0);

  return {
    length,
    pxPerBase,
    rowHeight,
    depth,
    arcs,
    maxDepth,
    width: Math.max(1, length) * pxPerBase,
    height: (maxDepth + 1) * rowHeight,
    maxScore,
  };
}

/** Quadratic arc as an SVG path. The control point sits at twice the rise, so
 *  the curve's peak lands exactly on `apex`. */
export function arcPath(arc: StructureArc, pxPerBase: number, x0: number): string {
  const x1 = x0 + arc.i * pxPerBase + pxPerBase / 2;
  const x2 = x0 + arc.j * pxPerBase + pxPerBase / 2;
  const cy = 2 * arc.apex - arc.y;
  return `M ${x1.toFixed(2)} ${arc.y.toFixed(2)} Q ${((x1 + x2) / 2).toFixed(2)} ${cy.toFixed(2)} ${x2.toFixed(2)} ${arc.y.toFixed(2)}`;
}

/** Nucleotide classes, for restrained colouring that still separates
 *  purines from pyrimidines without turning the diagram into confetti. */
export function residueTone(char: string): "purine" | "pyrimidine" | "other" {
  if (char === "A" || char === "G") return "purine";
  if (char === "C" || char === "U" || char === "T") return "pyrimidine";
  return "other";
}

export const COMPLEMENT: Record<string, string> = {
  A: "U",
  U: "A",
  T: "A",
  G: "C",
  C: "G",
};

/** True when two positions are Watson-Crick or wobble compatible. Used to flag
 *  a pair list that disagrees with its own sequence. */
export function pairsAreCompatible(sequence: string, pair: [number, number]): boolean {
  const a = sequence[pair[0]]?.toUpperCase();
  const b = sequence[pair[1]]?.toUpperCase();
  if (!a || !b) return false;
  if (isGapChar(a) || isGapChar(b)) return false;
  return (
    (a === "A" && (b === "U" || b === "T")) ||
    (a === "U" && (b === "A" || b === "G")) ||
    (a === "G" && (b === "C" || b === "U")) ||
    (a === "C" && (b === "G")) ||
    (a === "T" && b === "A")
  );
}

function isGapChar(char: string): boolean {
  return char === "-" || char === "." || char === "~";
}
