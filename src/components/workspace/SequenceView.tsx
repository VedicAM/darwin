/**
 * Sequence view.
 *
 * Painted to a canvas rather than assembled from `<span>`s: a 5 Mb transcript
 * would otherwise be five million DOM nodes, and the panel has to stay
 * responsive while a tool is still running. Only the visible lines are drawn,
 * and only the visible residue range is walked, so cost is bound by the panel's
 * size and not by the sequence's length.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Dna, LoaderCircle, Play, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import type { RNAStructureArtifact, SequenceArtifact, SequenceRecord } from "@/lib/artifacts/types";
import { structureFromFold } from "@/lib/artifacts/project";
import { foldEnsemble } from "@/lib/harness";
import { formatPercent, gcContent, shortHash } from "@/lib/sequence";
import { ArtifactHeader, EmptyState, Readout, StatLine } from "./primitives";
import { MONO, usePalette } from "./palette";
import { pixelRatio, useViewport } from "./useViewport";

const LINE_HEIGHT = 18;
const GUTTER = 62;
const PAD_TOP = 8;
const MIN_CELL = 6;
const MAX_CELL = 20;
const DEFAULT_CELL = 11;

interface Selection {
  anchor: number;
  focus: number;
}

function slice(record: SequenceRecord, from: number, to: number): string {
  return record.sequence.slice(from, to + 1);
}

function statsFor(record: SequenceRecord, from: number, to: number) {
  const text = slice(record, from, to);
  return [
    { label: "Length", value: `${record.length.toLocaleString()} nt` },
    { label: "GC", value: formatPercent(record.gc) },
    { label: "At", value: `${from + 1}–${to + 1}` },
    { label: "Sub GC", value: formatPercent(gcContent(text)) },
  ];
}

export function SequenceView({
  artifact,
  onAdd,
}: {
  artifact: SequenceArtifact;
  onAdd: (artifact: RNAStructureArtifact) => void;
}) {
  const [activeId, setActiveId] = useState(artifact.records[0]?.id ?? "");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cell, setCell] = useState(DEFAULT_CELL);
  const [folding, setFolding] = useState(false);
  const [foldError, setFoldError] = useState<string | null>(null);
  const { ref, viewport } = useViewport<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const palette = usePalette();

  const record = useMemo(
    () => artifact.records.find((r) => r.id === activeId) ?? artifact.records[0],
    [artifact.records, activeId],
  );

  useEffect(() => {
    if (!artifact.records.some((r) => r.id === activeId)) {
      setActiveId(artifact.records[0]?.id ?? "");
      setSelection(null);
    }
  }, [artifact.records, activeId]);

  // Columns that fit, so the reflow follows the panel rather than a hard-coded
  // 60. A narrow window gets fewer, wider columns instead of a horizontal
  // scrollbar for a 40 nt sequence.
  const columns = Math.max(8, Math.min(80, Math.floor((viewport.width - GUTTER - 8) / cell)));
  const lineCount = record ? Math.ceil(record.length / columns) : 0;
  const contentHeight = lineCount * LINE_HEIGHT + PAD_TOP * 2;
  const contentWidth = GUTTER + columns * cell;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !record || viewport.width === 0 || viewport.height === 0) return;
    const dpr = pixelRatio();
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    // The canvas is a child of the scrolled content, so it is pinned to the
    // viewport by translating by the scroll offset and drawn in content space.
    canvas.style.transform = `translate(${viewport.scrollLeft}px, ${viewport.scrollTop}px)`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.translate(-viewport.scrollLeft, -viewport.scrollTop);
    ctx.textBaseline = "middle";
    ctx.font = MONO;

    const firstLine = Math.max(0, Math.floor((viewport.scrollTop - PAD_TOP) / LINE_HEIGHT));
    const lastLine = Math.min(
      lineCount,
      Math.ceil((viewport.scrollTop + viewport.height - PAD_TOP) / LINE_HEIGHT),
    );
    const range = selection
      ? { from: Math.min(selection.anchor, selection.focus), to: Math.max(selection.anchor, selection.focus) }
      : null;

    // Gutter ticks, one per line: the start position of that line's first base.
    ctx.fillStyle = palette.muted;
    ctx.font = MONO;
    ctx.textAlign = "right";
    for (let line = firstLine; line < lastLine; line += 1) {
      const y = PAD_TOP + line * LINE_HEIGHT + LINE_HEIGHT / 2;
      ctx.fillText(String(line * columns + 1), GUTTER - 8, y);
    }
    ctx.textAlign = "left";

    // Selection band, drawn under the letters so the text stays legible.
    if (range) {
      ctx.fillStyle = palette.selection;
      const from = Math.min(range.from, record.length - 1);
      const to = Math.min(range.to, record.length - 1);
      const fromLine = Math.floor(from / columns);
      const toLine = Math.floor(to / columns);
      for (let line = fromLine; line <= toLine; line += 1) {
        if (line < firstLine || line >= lastLine) continue;
        const lineStart = line * columns;
        const start = Math.max(from, lineStart) - lineStart;
        const end = Math.min(to, lineStart + columns - 1) - lineStart;
        const y = PAD_TOP + line * LINE_HEIGHT;
        ctx.fillRect(GUTTER + start * cell, y, (end - start + 1) * cell, LINE_HEIGHT);
      }
    }

    ctx.fillStyle = palette.foreground;
    for (let line = firstLine; line < lastLine; line += 1) {
      const y = PAD_TOP + line * LINE_HEIGHT + LINE_HEIGHT / 2;
      const from = line * columns;
      const chunk = record.sequence.slice(from, from + columns);
      for (let i = 0; i < chunk.length; i += 1) {
        const char = chunk[i];
        if (char === undefined || char === "-") continue;
        ctx.fillText(char, GUTTER + i * cell + cell / 2, y);
      }
    }
  }, [record, columns, lineCount, cell, viewport, palette, selection]);

  const cellAt = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current;
      if (!canvas || !record) return 0;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left + viewport.scrollLeft;
      const y = event.clientY - rect.top + viewport.scrollTop;
      const col = Math.floor((x - GUTTER) / cell);
      const line = Math.floor((y - PAD_TOP) / LINE_HEIGHT);
      if (col < 0 || line < 0 || line >= lineCount) return -1;
      return Math.min(line * columns + col, record.length - 1);
    },
    [columns, lineCount, record, cell, viewport.scrollLeft, viewport.scrollTop],
  );

  const [dragging, setDragging] = useState(false);

  if (!record) {
    return <EmptyState icon={Dna} title="No sequence in this artifact" />;
  }

  const range = selection
    ? { from: Math.min(selection.anchor, selection.focus), to: Math.max(selection.anchor, selection.focus) }
    : null;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard access can be denied; there is nothing useful to say about it
      // in a panel, and the selection is still on screen to copy by hand.
    }
  }

  async function predict() {
    if (!record) return;
    setFolding(true);
    setFoldError(null);
    try {
      const result = await foldEnsemble(record.sequence);
      onAdd(
        structureFromFold(
          result,
          `local:fold.ensemble:${shortHash(record.sequence)}`,
          `${record.name} · consensus structure`,
        ),
      );
    } catch (err) {
      setFoldError(typeof err === "string" ? err : "the fold could not be run");
    } finally {
      setFolding(false);
    }
  }

  return (
    <>
      <ArtifactHeader
        title={artifact.title}
        subtitle={`${record.name}${record.description ? ` · ${record.description}` : ""}`}
        actions={
          <>
            <button
              type="button"
              onClick={() => void copy(record.sequence)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors"
            >
              <Copy aria-hidden className="size-3" />
              Copy
            </button>
            <button
              type="button"
              onClick={() => void predict()}
              disabled={folding}
              className="border-border text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] transition-colors disabled:opacity-50"
            >
              {folding ? (
                <LoaderCircle aria-hidden className="size-3 animate-spin" />
              ) : (
                <Play aria-hidden className="size-3" />
              )}
              Predict structure
            </button>
          </>
        }
      />

      {foldError ? (
        <div
          role="alert"
          className="text-destructive flex shrink-0 items-start gap-2 border-b border-border px-5 py-2 text-[11.5px]"
        >
          <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span className="leading-relaxed">
            Could not predict a structure. {foldError}
            <span className="text-muted-foreground">
              {" "}
              The harness installs a folding tool before it can answer; see the activity log.
            </span>
          </span>
        </div>
      ) : null}

      {artifact.records.length > 1 ? (
        <div className="max-h-36 shrink-0 overflow-y-auto border-b border-border px-5 py-2">
          <ul className="m-0 flex list-none flex-col p-0">
            {artifact.records.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(candidate.id);
                    setSelection(null);
                  }}
                  className={cn(
                    "flex w-full items-baseline gap-3 rounded px-1 py-0.5 text-left transition-colors",
                    candidate.id === record.id ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <span
                    className={cn(
                      "truncate font-mono text-[11.5px]",
                      candidate.id === record.id ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {candidate.name}
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10.5px] tabular-nums">
                    {candidate.length.toLocaleString()} nt · {formatPercent(candidate.gc)} GC
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div ref={ref} className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ width: contentWidth, height: contentHeight }} className="relative">
          <canvas
            ref={canvasRef}
            className="absolute top-0 left-0"
            onPointerDown={(event) => {
              const index = cellAt(event);
              if (index < 0) {
                setSelection(null);
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
              setSelection({ anchor: index, focus: index });
            }}
            onPointerMove={(event) => {
              if (!dragging) return;
              const index = cellAt(event);
              if (index < 0) return;
              setSelection((current) => (current ? { ...current, focus: index } : current));
            }}
            onPointerUp={(event) => {
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => setDragging(false)}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-2">
        <StatLine
          stats={
            range && range.to > range.from
              ? statsFor(record, range.from, range.to)
              : [
                  { label: "Length", value: `${record.length.toLocaleString()} nt` },
                  { label: "GC", value: formatPercent(record.gc) },
                ]
          }
        />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-muted-foreground text-[10.5px]">Zoom</span>
          <input
            type="range"
            min={MIN_CELL}
            max={MAX_CELL}
            step={1}
            value={cell}
            aria-label="Column width"
            onChange={(event) => setCell(Number(event.currentTarget.value))}
            className="accent-foreground h-1 w-20"
          />
        </div>
      </div>
      {range && range.to > range.from ? (
        <Readout>
          <button
            type="button"
            onClick={() => void copy(slice(record, range.from, range.to))}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
          >
            <Copy aria-hidden className="size-3" />
            Copy selection
          </button>
        </Readout>
      ) : null}
    </>
  );
}
