import type { PagesDaily } from "./api.js";

/** Hard cap on how many page series can be shown at once. */
export const MAX_SELECTED = 10;

/** Top-N pages pre-selected by default (most popular first, capped at `max`). */
export function defaultSelected(pages: PagesDaily["pages"], max = MAX_SELECTED): string[] {
  return pages.slice(0, max).map((p) => p.page);
}

/**
 * Toggle a page in the selection. Removing always works; adding is ignored once
 * the selection is at `max` (the UI also disables unchecked boxes at the cap).
 */
export function toggleSelected(selected: string[], page: string, max = MAX_SELECTED): string[] {
  if (selected.includes(page)) {
    return selected.filter((p) => p !== page);
  }
  if (selected.length >= max) {
    return selected;
  }
  return [...selected, page];
}

export interface LineSeries {
  name: string;
  data: number[];
}

/**
 * Build ECharts line series for the currently-selected pages, preserving the
 * popularity order from the server (`data.series` is already most-popular-first).
 */
export function buildLineSeries(data: PagesDaily, selected: string[]): LineSeries[] {
  const chosen = new Set(selected);
  return data.series.filter((s) => chosen.has(s.page)).map((s) => ({ name: s.page, data: s.hits }));
}
