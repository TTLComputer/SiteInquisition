import { useLayoutEffect, type RefObject } from 'react';

/** A point (a right-click) or an element's box to put a menu next to. */
export type Anchor = { x: number; y: number } | DOMRect;

export interface PlaceOptions {
  /** Line the menu's left edge up with the anchor's (start) or its right edges (end). Flips when there is no room. */
  align?: 'start' | 'end';
  /** Space between anchor and menu. */
  gap?: number;
  /** Space kept clear at the window's edges. */
  margin?: number;
}

export interface Placement {
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
  above: boolean;
}

const box = (a: Anchor) => ('width' in a ? { left: a.left, right: a.right, top: a.top, bottom: a.bottom } : { left: a.x, right: a.x, top: a.y, bottom: a.y });

/**
 * Where a menu of a given size goes so it stays on screen: below the anchor
 * when it fits, above when that fits better, and shifted sideways so neither
 * edge leaves the window. When it fits neither way it takes the larger side
 * and scrolls. Pure, so it can be tested without a browser.
 */
export function placeMenu(size: { width: number; height: number }, anchor: Anchor, viewport: { width: number; height: number }, opts: PlaceOptions = {}): Placement {
  const m = opts.margin ?? 8;
  const gap = opts.gap ?? 4;
  const a = box(anchor);
  const maxWidth = Math.max(0, viewport.width - 2 * m);
  const w = Math.min(size.width, maxWidth);
  const below = viewport.height - a.bottom - gap - m;
  const aboveRoom = a.top - gap - m;
  let above = false;
  let top: number;
  let maxHeight: number;
  if (size.height <= below) {
    top = a.bottom + gap;
    maxHeight = below;
  } else if (size.height <= aboveRoom) {
    above = true;
    top = a.top - gap - size.height;
    maxHeight = aboveRoom;
  } else if (aboveRoom > below) {
    above = true;
    maxHeight = Math.max(0, aboveRoom);
    top = m;
  } else {
    maxHeight = Math.max(0, below);
    top = a.bottom + gap;
  }
  let left = (opts.align ?? 'start') === 'end' ? a.right - w : a.left;
  // Flip to the other alignment before sliding, so the menu stays attached to its button when it can.
  if (left < m && (opts.align ?? 'start') === 'end') left = a.left;
  if (left + w > viewport.width - m && (opts.align ?? 'start') === 'start') left = a.right - w;
  left = Math.max(m, Math.min(left, viewport.width - m - w));
  return { left: Math.round(left), top: Math.round(Math.max(m, top)), maxHeight: Math.floor(maxHeight), maxWidth, above };
}

/**
 * Keep a floating menu on screen. The menu is positioned `fixed`, so no
 * scrolling container or overflow clips it, and it is placed again when the
 * window is resized or anything scrolls.
 */
export function usePlacement(menu: RefObject<HTMLElement | null>, anchor: RefObject<HTMLElement | null> | Anchor | null, open: boolean, opts: PlaceOptions = {}) {
  const { align, gap, margin } = opts;
  const point = anchor && !('current' in anchor) ? anchor : null;
  const px = point ? box(point).left : 0;
  const py = point ? box(point).top : 0;
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = menu.current;
      const at = point ?? (anchor && 'current' in anchor ? anchor.current?.getBoundingClientRect() : undefined);
      if (!el || !at) return;
      el.style.position = 'fixed';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      const keep = el.scrollTop;
      el.style.maxHeight = '';
      const r = el.getBoundingClientRect();
      // Measure the natural height: scrollHeight covers content cut short by an earlier max-height.
      const p = placeMenu({ width: r.width, height: Math.max(r.height, el.scrollHeight) }, at, { width: window.innerWidth, height: window.innerHeight }, { align, gap, margin });
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
      el.style.maxWidth = `${p.maxWidth}px`;
      el.style.maxHeight = `${p.maxHeight}px`;
      el.style.overflowY = 'auto';
      el.scrollTop = keep;
      el.dataset.side = p.above ? 'above' : 'below';
    };
    place();
    // Contents change size (a filter narrows a list, data arrives); place again when they do.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : undefined;
    if (menu.current) ro?.observe(menu.current);
    // Scrolling inside the menu itself must not re-measure it (that would reset its scroll position).
    const onScroll = (e: Event) => {
      if (menu.current && e.target instanceof Node && menu.current.contains(e.target)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu, point ? null : anchor, px, py, align, gap, margin]);
}
