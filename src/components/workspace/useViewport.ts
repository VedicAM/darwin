/**
 * Viewport tracking for the canvas-backed views.
 *
 * An alignment of a few thousand columns cannot be thousands of DOM nodes, so
 * the sequence views paint into a canvas and read the scroll offset from here.
 * The scroller is the element being measured, which is also what keeps a long
 * sequence scrolling *inside* the visualisation instead of widening the window.
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export interface Viewport {
  width: number;
  height: number;
  scrollLeft: number;
  scrollTop: number;
}

const ZERO: Viewport = { width: 0, height: 0, scrollLeft: 0, scrollTop: 0 };

export function useViewport<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  viewport: Viewport;
} {
  const ref = useRef<T | null>(null);
  const [viewport, setViewport] = useState<Viewport>(ZERO);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const { clientWidth, clientHeight, scrollLeft, scrollTop } = element;
      setViewport((previous) =>
        previous.width === clientWidth &&
        previous.height === clientHeight &&
        previous.scrollLeft === scrollLeft &&
        previous.scrollTop === scrollTop
          ? previous
          : { width: clientWidth, height: clientHeight, scrollLeft, scrollTop },
      );
    };
    // Scroll events arrive faster than a frame on a trackpad; coalescing keeps
    // the redraw at most once per frame.
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
    };
  }, []);

  return { ref, viewport };
}

/** Backing-store scale, so text stays crisp on a HiDPI display. */
export function pixelRatio(): number {
  return typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
}
