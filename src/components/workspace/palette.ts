/**
 * Canvas colours, read from the theme.
 *
 * A canvas cannot inherit `currentColor`, so the palette is sampled out of the
 * CSS custom properties shadcn already defines. That keeps the sequence views in
 * the same light/dark theme as the rest of the panel without a second source of
 * truth, and re-samples when the OS scheme flips.
 */

import { useEffect, useMemo, useState } from "react";

export interface Palette {
  foreground: string;
  muted: string;
  faint: string;
  border: string;
  selection: string;
  accent: string;
  surface: string;
  warn: string;
}

const LIGHT: Palette = {
  foreground: "#1c1c1c",
  muted: "#8a8a8a",
  faint: "#b4b4b4",
  border: "#e4e4e4",
  selection: "rgba(28, 28, 28, 0.12)",
  accent: "#2563eb",
  surface: "#fafafa",
  warn: "#dc2626",
};

const DARK: Palette = {
  foreground: "#ededed",
  muted: "#9a9a9a",
  faint: "#6b6b6b",
  border: "#2e2e2e",
  selection: "rgba(237, 237, 237, 0.14)",
  accent: "#7aa2f7",
  surface: "#1c1c1c",
  warn: "#f87171",
};

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function sample(dark: boolean): Palette {
  const base = dark ? DARK : LIGHT;
  if (typeof window === "undefined") return base;
  const styles = getComputedStyle(document.documentElement);
  return {
    foreground: cssVar(styles, "--foreground", base.foreground),
    muted: cssVar(styles, "--muted-foreground", base.muted),
    faint: cssVar(styles, "--border", base.faint),
    border: cssVar(styles, "--border", base.border),
    selection: dark ? "rgba(237, 237, 237, 0.14)" : "rgba(28, 28, 28, 0.12)",
    accent: cssVar(styles, "--ring", base.accent),
    surface: cssVar(styles, "--muted", base.surface),
    warn: cssVar(styles, "--destructive", base.warn),
  };
}

export function usePalette(): Palette {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(query);
    const onChange = () => setDark(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return useMemo(() => sample(dark), [dark]);
}

export const MONO = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
export const MONO_SMALL = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
