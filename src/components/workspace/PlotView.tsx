/**
 * Minimal line/scatter plot.
 *
 * Not a charting library: one canvas, linear axes, one line per series. It
 * exists so a tool that returns numbers has somewhere to put them, and it stays
 * small enough to read.
 */

import { useEffect, useRef } from "react";
import { ChartSpline } from "lucide-react";
import type { PlotArtifact } from "@/lib/artifacts/types";
import { ArtifactHeader, EmptyState } from "./primitives";
import { MONO_SMALL, usePalette } from "./palette";
import { pixelRatio, useViewport } from "./useViewport";

const PAD = { left: 46, right: 12, top: 10, bottom: 22 };
/** The theme's own chart ramp, in order, for series without an explicit colour. */
const SERIES_COLOURS = ["#3b6fd4", "#b4530f", "#0f766e", "#9333ea", "#b91c1c"];

function extent(values: number[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  return [min, max];
}

function ticks(low: number, high: number, count: number): number[] {
  const span = high - low;
  if (span <= 0) return [low];
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const out: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + step / 2; value += step) {
    out.push(Number(value.toFixed(10)));
  }
  return out;
}

export function PlotView({ artifact }: { artifact: PlotArtifact }) {
  const { series, xLabel, yLabel } = artifact;
  const { ref, viewport } = useViewport<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const palette = usePalette();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewport.width === 0 || viewport.height === 0 || series.length === 0) return;
    const dpr = pixelRatio();
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.font = MONO_SMALL;
    ctx.textBaseline = "middle";

    const xs = series.flatMap((s) => s.points.map((p) => p[0]));
    const ys = series.flatMap((s) => s.points.map((p) => p[1]));
    const [x0, x1] = extent(xs);
    const [y0, y1] = extent(ys);

    const plotW = viewport.width - PAD.left - PAD.right;
    const plotH = viewport.height - PAD.top - PAD.bottom;
    if (plotW <= 0 || plotH <= 0) return;
    const sx = (x: number) => PAD.left + ((x - x0) / (x1 - x0)) * plotW;
    const sy = (y: number) => PAD.top + plotH - ((y - y0) / (y1 - y0)) * plotH;

    ctx.strokeStyle = palette.border;
    ctx.lineWidth = 1;
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "right";
    for (const tick of ticks(y0, y1, 4)) {
      const y = sy(tick);
      if (y < PAD.top - 1 || y > PAD.top + plotH + 1) continue;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + plotW, y);
      ctx.stroke();
      ctx.fillText(String(tick), PAD.left - 6, y);
    }
    ctx.textAlign = "center";
    for (const tick of ticks(x0, x1, 5)) {
      const x = sx(tick);
      if (x < PAD.left - 1 || x > PAD.left + plotW + 1) continue;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.fillText(String(tick), x, PAD.top + plotH + 10);
    }

    ctx.textAlign = "left";
    series.forEach((entry, index) => {
      if (entry.points.length === 0) return;
      ctx.strokeStyle = entry.color ?? SERIES_COLOURS[index % SERIES_COLOURS.length];
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      entry.points.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(sx(x), sy(y));
        else ctx.lineTo(sx(x), sy(y));
      });
      ctx.stroke();
      // One dot per point, capped so a dense series stays a line.
      if (entry.points.length <= 200) {
        ctx.fillStyle = entry.color ?? SERIES_COLOURS[index % SERIES_COLOURS.length];
        for (const [x, y] of entry.points) ctx.fillRect(sx(x) - 1, sy(y) - 1, 2, 2);
      }
    });

    if (xLabel) {
      ctx.fillStyle = palette.muted;
      ctx.textAlign = "right";
      ctx.fillText(xLabel, PAD.left + plotW, viewport.height - 4);
    }
    if (yLabel) {
      ctx.save();
      ctx.translate(10, PAD.top);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "right";
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }
  }, [series, viewport, palette, xLabel, yLabel]);

  if (series.length === 0) {
    return <EmptyState icon={ChartSpline} title="No series" />;
  }

  return (
    <>
      <ArtifactHeader
        title={artifact.title}
        subtitle={series.map((entry) => entry.name).join(" · ")}
      />
      <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas ref={canvasRef} className="absolute top-0 left-0" />
      </div>
    </>
  );
}
