/**
 * Multiple sequence alignment viewer.
 *
 * One canvas, three layers: the grid, a sticky name column, and a sticky
 * position ruler with a conservation strip under it. Thousands of columns and
 * thousands of rows cost one repaint of the visible window — a DOM-per-residue
 * alignment is the classic way a chat app falls over on real data.
 *
 * Conservation shading is positional (the most common residue's share of a
 * column), drawn as a strip rather than as per-cell colour so the letters stay
 * readable at every zoom.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Rows3 } from "lucide-react";
import type { AlignmentArtifact } from "@/lib/artifacts/types";
import { formatPercent, gcContent, isGap } from "@/lib/sequence";
import { ArtifactHeader, EmptyState, Readout } from "./primitives";
import { MONO, MONO_SMALL, usePalette } from "./palette";
import { pixelRatio, useViewport } from "./useViewport";

const ROW_HEIGHT = 16;
const RULER_HEIGHT = 20;
const STRIP_HEIGHT = 4;
const PAD = 6;
const ZOOMS = [1, 1.5, 2, 3, 4] as const;

/** The natural advance of the mono font, so a column is a whole number of
 *  characters wide and a row can be drawn with a single `fillText`. */
let advance: number | null = null;
function charAdvance(): number {
  if (advance !== null) return advance;
  if (typeof document === "undefined") return 6;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return 6;
  ctx.font = MONO;
  advance = ctx.measureText("M").width || 6;
  return advance;
}

interface Selection {
  anchorRow: number;
  anchorCol: number;
  focusRow: number;
  focusCol: number;
}

export function AlignmentView({ artifact }: { artifact: AlignmentArtifact }) {
  const { rows, width, conservation } = artifact;
  const [zoomIndex, setZoomIndex] = useState(2);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dragging, setDragging] = useState(false);
  const { ref, viewport } = useViewport<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const palette = usePalette();

  const cellWidth = Math.max(4, Math.round(charAdvance() * ZOOMS[zoomIndex]));
  const nameWidth = useMemo(() => {
    const longest = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
    return Math.min(220, Math.max(80, longest * 6.6 + 16));
  }, [rows]);
  const contentWidth = nameWidth + width * cellWidth;
  const contentHeight = RULER_HEIGHT + STRIP_HEIGHT + rows.length * ROW_HEIGHT + PAD;

  // Whole-alignment statistics, computed once: the readout should not re-scan
  // every column on each selection change.
  const summary = useMemo(() => {
    let gaps = 0;
    let total = 0;
    for (const row of rows) {
      for (const char of row.row) {
        total += 1;
        if (isGap(char)) gaps += 1;
      }
    }
    const cons = conservation ?? [];
    let sum = 0;
    for (const value of cons) sum += value;
    return {
      gapFraction: total === 0 ? 0 : gaps / total,
      meanConservation: cons.length === 0 ? 0 : sum / cons.length,
    };
  }, [rows, conservation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.width === 0 || viewport.height === 0 || rows.length === 0) return;
    const dpr = pixelRatio();
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.style.transform = `translate(${viewport.scrollLeft}px, ${viewport.scrollTop}px)`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.textBaseline = "middle";

    const gridTop = RULER_HEIGHT + STRIP_HEIGHT;
    const firstCol = Math.max(0, Math.floor((viewport.scrollLeft - nameWidth) / cellWidth));
    const lastCol = Math.min(width - 1, Math.ceil((viewport.scrollLeft + viewport.width) / cellWidth));
    const firstRow = Math.max(
      0,
      Math.floor((viewport.scrollTop - gridTop) / ROW_HEIGHT),
    );
    const lastRow = Math.min(
      rows.length,
      Math.ceil((viewport.scrollTop + viewport.height - gridTop) / ROW_HEIGHT),
    );

    const range = selection
      ? {
          fromCol: Math.min(selection.anchorCol, selection.focusCol),
          toCol: Math.max(selection.anchorCol, selection.focusCol),
          fromRow: Math.min(selection.anchorRow, selection.focusRow),
          toRow: Math.max(selection.anchorRow, selection.focusRow),
        }
      : null;

    // --- grid (content space) ---
    ctx.save();
    ctx.translate(-viewport.scrollLeft, -viewport.scrollTop);
    ctx.font = MONO;
    ctx.textAlign = "left";

    if (range) {
      ctx.fillStyle = palette.selection;
      ctx.fillRect(
        nameWidth + range.fromCol * cellWidth,
        gridTop + range.fromRow * ROW_HEIGHT,
        (range.toCol - range.fromCol + 1) * cellWidth,
        (range.toRow - range.fromRow + 1) * ROW_HEIGHT,
      );
    }

    // Low-conservation columns get a faint wash: the interesting places in an
    // alignment are the ones that are free to vary.
    if (conservation) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        const value = conservation[col];
        if (value === undefined || value > 0.82) continue;
        ctx.fillStyle = palette.selection;
        ctx.globalAlpha = (0.82 - value) * 1.6;
        ctx.fillRect(nameWidth + col * cellWidth, gridTop, cellWidth, (lastRow - firstRow) * ROW_HEIGHT);
      }
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = palette.foreground;
    for (let row = firstRow; row < lastRow; row += 1) {
      const line = rows[row]?.row;
      if (!line) continue;
      const y = gridTop + row * ROW_HEIGHT + ROW_HEIGHT / 2;
      const chunk = line.slice(firstCol, lastCol + 1);
      // Residues are drawn in runs, at their real column offsets, so a single
      // `fillText` per run keeps a thousand-column row cheap without ever
      // compressing a row and losing column alignment.
      let runStart = -1;
      for (let i = 0; i <= chunk.length; i += 1) {
        const gap = i === chunk.length || isGap(chunk[i]);
        if (gap && runStart >= 0) {
          ctx.fillStyle = palette.foreground;
          ctx.fillText(chunk.slice(runStart, i), nameWidth + (firstCol + runStart) * cellWidth, y);
          runStart = -1;
        } else if (!gap && runStart < 0) {
          runStart = i;
        }
      }
    }
    ctx.restore();

    // --- sticky layers (viewport space, drawn over the grid) ---
    ctx.textAlign = "left";
    ctx.font = MONO_SMALL;
    ctx.fillStyle = palette.surface;
    ctx.fillRect(0, 0, viewport.width, RULER_HEIGHT + STRIP_HEIGHT);
    ctx.fillRect(0, 0, nameWidth, viewport.height);

    // Conservation strip, under the ruler: a column-wise bar, so the conserved
    // cores are visible without colouring a single residue.
    if (conservation) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        const value = conservation[col];
        if (value === undefined) continue;
        ctx.fillStyle = palette.foreground;
        ctx.globalAlpha = 0.12 + value * 0.5;
        ctx.fillRect(
          nameWidth + col * cellWidth,
          RULER_HEIGHT,
          Math.max(1, cellWidth - (cellWidth > 6 ? 1 : 0)),
          STRIP_HEIGHT,
        );
      }
      ctx.globalAlpha = 1;
    }

    ctx.font = MONO_SMALL;
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "center";
    const tick = ZOOMS[zoomIndex] >= 3 ? 25 : 10;
    for (let col = Math.ceil(firstCol / tick) * tick; col <= lastCol; col += tick) {
      const x = nameWidth + col * cellWidth + cellWidth / 2;
      ctx.fillText(String(col + 1), x, RULER_HEIGHT / 2 - 1);
      ctx.fillRect(x, RULER_HEIGHT - 3, 1, 3);
    }
    ctx.textAlign = "left";

    // Name column, redrawn last so it sits over the grid, with a rule at the
    // edge so the boundary stays findable while scrolling.
    ctx.font = MONO;
    ctx.fillStyle = palette.muted;
    for (let row = firstRow; row < lastRow; row += 1) {
      const entry = rows[row];
      if (!entry) continue;
      const y = gridTop + row * ROW_HEIGHT + ROW_HEIGHT / 2;
      const label = entry.name.length > 24 ? `${entry.name.slice(0, 23)}…` : entry.name;
      ctx.fillText(label, 8, y);
    }
    ctx.fillStyle = palette.border;
    ctx.fillRect(nameWidth - 1, 0, 1, viewport.height);
    ctx.fillRect(0, RULER_HEIGHT + STRIP_HEIGHT - 1, viewport.width, 1);
  }, [rows, width, conservation, cellWidth, nameWidth, viewport, palette, selection, zoomIndex]);

  const cellAt = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left + viewport.scrollLeft - nameWidth;
      const y = event.clientY - rect.top + viewport.scrollTop - (RULER_HEIGHT + STRIP_HEIGHT);
      if (x < 0 || y < 0) return null;
      const col = Math.min(width - 1, Math.floor(x / cellWidth));
      const row = Math.min(rows.length - 1, Math.floor(y / ROW_HEIGHT));
      if (col < 0 || row < 0) return null;
      return { row, col };
    },
    [cellWidth, nameWidth, rows.length, viewport.scrollLeft, viewport.scrollTop, width],
  );

  const range = selection
    ? {
        fromCol: Math.min(selection.anchorCol, selection.focusCol),
        toCol: Math.max(selection.anchorCol, selection.focusCol),
        fromRow: Math.min(selection.anchorRow, selection.focusRow),
        toRow: Math.max(selection.anchorRow, selection.focusRow),
      }
    : null;

  /** The selected block as FASTA, for the copy action and the GC readout. */
  const selectionText = useMemo(() => {
    if (!selection) return "";
    const fromRow = Math.min(selection.anchorRow, selection.focusRow);
    const toRow = Math.max(selection.anchorRow, selection.focusRow);
    const fromCol = Math.min(selection.anchorCol, selection.focusCol);
    const toCol = Math.max(selection.anchorCol, selection.focusCol);
    const lines: string[] = [];
    for (let row = fromRow; row <= toRow; row += 1) {
      lines.push(rows[row]?.row.slice(fromCol, toCol + 1) ?? "");
    }
    return lines.join("\n");
  }, [selection, rows]);

  if (rows.length === 0) {
    return <EmptyState icon={Rows3} title="Empty alignment" />;
  }

  return (
    <>
      <ArtifactHeader
        title={artifact.title}
        subtitle={`${rows.length} sequences × ${width.toLocaleString()} columns · ${artifact.format}`}
        actions={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
              disabled={zoomIndex === 0}
              aria-label="Zoom out"
              className="border-border text-muted-foreground hover:text-foreground rounded-md border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-40"
            >
              −
            </button>
            <span className="text-muted-foreground w-8 text-center font-mono text-[10.5px] tabular-nums">
              {ZOOMS[zoomIndex]}×
            </span>
            <button
              type="button"
              onClick={() => setZoomIndex((index) => Math.min(ZOOMS.length - 1, index + 1))}
              disabled={zoomIndex === ZOOMS.length - 1}
              aria-label="Zoom in"
              className="border-border text-muted-foreground hover:text-foreground rounded-md border px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-40"
            >
              +
            </button>
          </div>
        }
      />

      <div ref={ref} className="min-h-0 flex-1 overflow-auto">
        <div style={{ width: contentWidth, height: contentHeight }} className="relative">
          <canvas
            ref={canvasRef}
            className="absolute top-0 left-0"
            onPointerDown={(event) => {
              const at = cellAt(event);
              if (!at) {
                setSelection(null);
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
              setSelection({ anchorRow: at.row, anchorCol: at.col, focusRow: at.row, focusCol: at.col });
            }}
            onPointerMove={(event) => {
              if (!dragging) return;
              const at = cellAt(event);
              if (!at) return;
              setSelection((current) =>
                current ? { ...current, focusRow: at.row, focusCol: at.col } : current,
              );
            }}
            onPointerUp={(event) => {
              setDragging(false);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => setDragging(false)}
          />
        </div>
      </div>

      <Readout>
        <span>
          Columns{" "}
          <span className="text-foreground font-mono tabular-nums">
            {range ? `${range.fromCol + 1}–${range.toCol + 1}` : `1–${width}`}
          </span>
        </span>
        <span>
          Gaps <span className="text-foreground font-mono tabular-nums">{formatPercent(summary.gapFraction)}</span>
        </span>
        <span>
          Mean conservation{" "}
          <span className="text-foreground font-mono tabular-nums">
            {formatPercent(summary.meanConservation)}
          </span>
        </span>
        {range && range.toCol > range.fromCol ? (
          <span>
            GC{" "}
            <span className="text-foreground font-mono tabular-nums">
              {formatPercent(gcContent(selectionText.replace(/\s/g, "")))}
            </span>
          </span>
        ) : null}
        {range ? (
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(selectionText)}
            className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 transition-colors"
          >
            <Copy aria-hidden className="size-3" />
            Copy block
          </button>
        ) : null}
      </Readout>
    </>
  );
}
