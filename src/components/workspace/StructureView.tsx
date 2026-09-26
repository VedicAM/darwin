/**
 * RNA secondary-structure diagram.
 *
 * Consumes `{ sequence, pairs }` and nothing else: no tool name, no fold
 * parameters, no assumption about where the pairs came from. A dot-bracket
 * string, an explicit pair list and an ensemble's probabilities all land in the
 * same shape, so this renders whatever a tool produced.
 *
 * Drawing is SVG, windowed by scroll offset: an arc diagram of a 4 kb sequence
 * is still only a few hundred elements once the off-screen arcs are dropped, and
 * unlike a canvas it stays selectable and inspectable.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Minus, Plus } from "lucide-react";
import { cn } from "cn";
import type { RNAStructureArtifact } from "@/lib/artifacts/types";
import { arcPath, layoutStructure, pairsAreCompatible, residueTone } from "@/lib/structure";
import { ArtifactHeader, ErrorState, Readout, StatLine } from "./primitives";
import { usePalette } from "./palette";
import { useViewport } from "./useViewport";

const ROW_HEIGHT = 22;
const PAD_X = 24;
const PAD_TOP = 18;
const LABEL_HEIGHT = 16;
const ZOOMS = [3, 5, 7, 9, 12, 16, 22, 30] as const;

const TONE_CLASS: Record<"purine" | "pyrimidine" | "other", string> = {
  purine: "fill-foreground",
  pyrimidine: "fill-muted-foreground",
  other: "fill-muted-foreground/50",
};

export function StructureView({ artifact }: { artifact: RNAStructureArtifact }) {
  const [zoomIndex, setZoomIndex] = useState(2);
  const [selected, setSelected] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const { ref } = useViewport<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const palette = usePalette();

  const length = artifact.sequence.length;
  const pxPerBase = ZOOMS[zoomIndex];

  /** Out-of-range and self-referential pairs are a tool bug, not a rendering
   *  problem, so they are reported rather than clamped away. */
  const invalid = useMemo(
    () =>
      artifact.pairs.filter(
        (pair) =>
          !Number.isInteger(pair.i) ||
          !Number.isInteger(pair.j) ||
          pair.i < 0 ||
          pair.j < 0 ||
          pair.i >= length ||
          pair.j >= length ||
          pair.i === pair.j,
      ),
    [artifact.pairs, length],
  );

  const incompatible = useMemo(
    () => artifact.pairs.filter((pair) => !pairsAreCompatible(artifact.sequence, [pair.i, pair.j])),
    [artifact.pairs, artifact.sequence],
  );

  const partnerOf = useMemo(() => {
    const map = new Map<number, number>();
    for (const pair of artifact.pairs) {
      if (map.has(pair.i) || map.has(pair.j)) continue;
      map.set(pair.i, pair.j);
      map.set(pair.j, pair.i);
    }
    return map;
  }, [artifact.pairs]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  const layout = useMemo(
    () => layoutStructure(length, artifact.pairs, pxPerBase, ROW_HEIGHT),
    [length, artifact.pairs, pxPerBase],
  );

  // Fit to the panel on the first layout, then leave the zoom alone: a resize
  // should not fight a user who has chosen a scale.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || width === 0 || length === 0) return;
    fitted.current = true;
    const fit = (width - PAD_X * 2) / length;
    if (fit >= ZOOMS[ZOOMS.length - 1]) {
      setZoomIndex(ZOOMS.length - 1);
      return;
    }
    const index = ZOOMS.findIndex((zoom) => zoom >= fit);
    setZoomIndex(index < 0 ? ZOOMS.length - 1 : Math.max(0, index));
  }, [width, length]);

  const [scrollLeft, setScrollLeft] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = () => setScrollLeft(element.scrollLeft);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [ref]);

  /** Windowing, quantised to a band of columns: a scroll re-renders when it
   *  leaves the band, not on every pixel. */
  const band = pxPerBase * 16;
  const quantised = Math.floor(scrollLeft / band) * band;
  const windowed = useMemo(() => {
    const from = Math.max(0, Math.floor(quantised / pxPerBase) - 2);
    const to = Math.min(length, Math.ceil((quantised + (width || 1)) / pxPerBase) + 2);
    return { from, to };
  }, [quantised, length, pxPerBase, width]);

  const height = layout.height + PAD_TOP + LABEL_HEIGHT;
  const svgWidth = layout.width + PAD_X * 2;
  const baseline = PAD_TOP + layout.maxDepth * ROW_HEIGHT;

  if (length === 0) {
    return (
      <ErrorState title="Nothing to draw" detail={`The artifact carries a sequence of ${length} residues.`} />
    );
  }

  if (artifact.problem || invalid.length > 0) {
    return (
      <ErrorState
        title="Unable to render structure"
        detail={
          artifact.problem ??
          `${invalid.length} base pair(s) fall outside the ${length}-residue sequence, or point at a single position.`
        }
      >
        The pair list does not match the sequence it came with, so the diagram would be a guess. Check the
        tool&apos;s own output before trusting any number derived from it.
      </ErrorState>
    );
  }

  const paired = new Set<number>();
  for (const pair of artifact.pairs) {
    paired.add(pair.i);
    paired.add(pair.j);
  }
  const partner = selected === null ? undefined : partnerOf.get(selected);
  const showLabels = pxPerBase >= 9;
  const showPositions = pxPerBase >= 22;

  function indexAt(clientX: number): number | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = clientX - rect.left - PAD_X;
    const index = Math.floor(x / pxPerBase);
    if (index < 0 || index >= length) return null;
    return index;
  }

  return (
    <>
      <ArtifactHeader
        title={artifact.title}
        subtitle={`${length.toLocaleString()} nt · ${artifact.pairs.length} base pairs`}
        actions={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
              disabled={zoomIndex === 0}
              aria-label="Zoom out"
              className="border-border text-muted-foreground hover:text-foreground rounded-md border p-1 transition-colors disabled:opacity-40"
            >
              <Minus aria-hidden className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => setZoomIndex((index) => Math.min(ZOOMS.length - 1, index + 1))}
              disabled={zoomIndex === ZOOMS.length - 1}
              aria-label="Zoom in"
              className="border-border text-muted-foreground hover:text-foreground rounded-md border p-1 transition-colors disabled:opacity-40"
            >
              <Plus aria-hidden className="size-3" />
            </button>
          </div>
        }
      />

      <div ref={ref} className="min-h-0 flex-1 overflow-auto">
        <svg
          ref={svgRef}
          width={svgWidth}
          height={height}
          role="img"
          aria-label={`Secondary structure of ${artifact.name ?? "a"} ${length} nucleotide RNA with ${artifact.pairs.length} base pairs`}
          onPointerDown={(event) => setSelected(indexAt(event.clientX))}
          className="touch-none"
        >
          {/* Baseline the arcs spring from. */}
          <line
            x1={PAD_X}
            x2={PAD_X + layout.width}
            y1={baseline}
            y2={baseline}
            stroke={palette.border}
            strokeWidth={1}
          />

          {layout.arcs
            .filter((arc) => arc.j >= windowed.from && arc.i <= windowed.to)
            .map((arc) => {
              const isSelected = selected !== null && (arc.i === selected || arc.j === selected);
              const confidence = arc.score === undefined || layout.maxScore === 0
                ? undefined
                : Math.max(0.15, Math.min(1, arc.score / layout.maxScore));
              return (
                <path
                  key={`${arc.i}-${arc.j}`}
                  d={arcPath(arc, pxPerBase, PAD_X)}
                  fill="none"
                  stroke={isSelected ? palette.accent : palette.foreground}
                  strokeOpacity={isSelected ? 1 : confidence === undefined ? 0.45 : 0.15 + confidence * 0.6}
                  strokeWidth={isSelected ? 2 : 1.1}
                />
              );
            })}

          {/* Backbone: a polyline through the base positions, so a stem is a
              vertical run and a bulge is a step. */}
          <polyline
            fill="none"
            stroke={palette.border}
            strokeWidth={1}
            points={buildBackbone(layout.depth, pxPerBase, PAD_X, PAD_TOP, windowed.from, windowed.to)}
          />

          {Array.from({ length: Math.max(0, windowed.to - windowed.from) }, (_, offset) => {
            const index = windowed.from + offset;
            const char = artifact.sequence[index];
            if (!char) return null;
            const x = PAD_X + index * pxPerBase + pxPerBase / 2;
            const y = PAD_TOP + layout.depth[index] * ROW_HEIGHT;
            const isSelected = index === selected || index === partner;
            const dim = selected !== null && !isSelected;
            return (
              <g key={index}>
                {isSelected ? (
                  <circle cx={x} cy={y} r={pxPerBase * 0.62} fill={palette.accent} fillOpacity={0.18} />
                ) : null}
                {showLabels ? (
                  <text
                    x={x}
                    y={y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={Math.min(12, pxPerBase * 0.86)}
                    className={cn(TONE_CLASS[residueTone(char)], dim && "opacity-30")}
                  >
                    {char}
                  </text>
                ) : null}
                {showPositions ? (
                  <text
                    x={x}
                    y={baseline + 13}
                    textAnchor="middle"
                    fontSize={8}
                    className="fill-muted-foreground"
                  >
                    {index + 1}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-2">
        <StatLine
          stats={[
            { label: "Length", value: `${length.toLocaleString()} nt` },
            { label: "Paired", value: `${Math.round((paired.size / length) * 100)}%` },
            {
              label: "MFE",
              value: artifact.metrics.find((m) => m.label === "MFE")?.value ?? "—",
            },
          ]}
        />
        <div className="text-muted-foreground ml-auto flex items-center gap-3 text-[10.5px]">
          {artifact.pairs.some((pair) => pair.score !== undefined) ? (
            <span className="flex items-center gap-1.5">
              <span className="bg-foreground/20 inline-block h-px w-6" />
              <span className="bg-foreground/80 inline-block h-px w-6" />
              low → high pair confidence
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(artifact.notation ?? toNotation(artifact))}
            className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
          >
            <Copy aria-hidden className="size-3" />
            Notation
          </button>
        </div>
      </div>

      {selected !== null ? (
        <Readout>
          <span>
            Position{" "}
            <span className="text-foreground font-mono tabular-nums">{selected + 1}</span>
          </span>
          <span>
            Base <span className="text-foreground font-mono">{artifact.sequence[selected]}</span>
          </span>
          <span>
            {partner === undefined
              ? "unpaired"
              : `paired with ${partner + 1} (${artifact.sequence[partner]})`}
          </span>
        </Readout>
      ) : null}

      {incompatible.length > 0 ? (
        <div className="text-muted-foreground shrink-0 border-t border-border px-5 py-1.5 text-[10.5px]">
          {incompatible.length} pair(s) are not Watson-Crick or wobble compatible with the sequence.
        </div>
      ) : null}
    </>
  );
}

/** Polyline through the visible base positions, skipping the hidden middle. */
function buildBackbone(
  depth: Int32Array,
  pxPerBase: number,
  padX: number,
  padTop: number,
  from: number,
  to: number,
): string {
  const points: string[] = [];
  for (let i = from; i < to; i += 1) {
    points.push(`${(padX + i * pxPerBase + pxPerBase / 2).toFixed(1)},${(padTop + depth[i] * ROW_HEIGHT).toFixed(1)}`);
  }
  return points.join(" ");
}

/** Rebuild dot-bracket from a pair list when the producer gave none. */
function toNotation(artifact: RNAStructureArtifact): string {
  const chars = [...artifact.sequence].map(() => ".");
  for (const pair of artifact.pairs) {
    if (pair.i < 0 || pair.j < 0 || pair.i >= chars.length || pair.j >= chars.length) continue;
    chars[pair.i] = "(";
    chars[pair.j] = ")";
  }
  return chars.join("");
}
