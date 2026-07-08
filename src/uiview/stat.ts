// Shared StatPanel computation — the ONE TypeScript implementation of a KPI
// tile's delta / trend / formatting, imported by every TS renderer (web-react's
// html/shadcn kits, mui-kit, and the web-components renderer) so none diverge.
// The Rust renderer (tui, via meridian-uiview-core) mirrors this EXACTLY; a
// parity test in each language asserts identical output for identical input.
//
// The delta/trend is COMPUTED from the data (previous / series), never trusted
// from an author-marked direction — that catches a declining metric mislabeled
// "up". `trend_override` / `delta_override` are escape hatches only. Semantic
// good/bad color is applied ONLY when `higher_is_better` is explicitly set.
//
// Number formatting is deterministic integer math (no toLocaleString), so it is
// byte-identical to the Rust formatter.

import type { StatPanel } from "@savvifi/meridian-proto-ts/proto/stat_pb.js";

export type StatTrend = "up" | "down" | "flat" | "none";
export type StatSemantics = "good" | "bad" | "neutral";

export interface StatComputed {
  /** The formatted value + unit suffix (e.g. "1,234 employees", "87.5%"). */
  formattedValue: string;
  /** Computed (or overridden) trend direction; "none" when there is no delta. */
  trend: StatTrend;
  /** Formatted signed delta (e.g. "+30", "-5.0%"), or null when there is none. */
  formattedDelta: string | null;
  /** good/bad ONLY when higher_is_better is set; otherwise neutral. */
  semantics: StatSemantics;
  /** The series (oldest→newest) driving an optional sparkline; [] when <2 points. */
  series: number[];
}

// ValueFormat enum values (stat.proto): 0/1 = number, 2 = percent, 3 = currency,
// 4 = compact, 5 = plain.
// ── deterministic number formatting (matches the Rust formatter) ─────────────

// Decompose |round(n, 2dp)| into (negative, integerPart, frac00..99).
function parts(n: number): { neg: boolean; int: number; frac: number } {
  // round half away from zero at 2 dp, via integer scaling.
  const scaled = Math.round(Math.abs(n) * 100 + 1e-9) * (n < 0 ? -1 : 1);
  const neg = scaled < 0;
  const a = Math.abs(scaled);
  return { neg, int: Math.floor(a / 100), frac: a % 100 };
}

function group(int: number): string {
  const s = String(int);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

// A number → string, grouped or not, integer if whole else up to 2 dp (trailing
// zeros stripped).
function trimNum(n: number, grouped: boolean): string {
  const { neg, int, frac } = parts(n);
  let s = grouped ? group(int) : String(int);
  if (frac !== 0) {
    let f = String(frac).padStart(2, "0").replace(/0+$/, "");
    if (f === "") f = "0";
    s = `${s}.${f}`;
  }
  return neg && !(int === 0 && frac === 0) ? `-${s}` : s;
}

function currency(n: number): string {
  const { neg, int, frac } = parts(n);
  const s = `$${group(int)}.${String(frac).padStart(2, "0")}`;
  return neg && !(int === 0 && frac === 0) ? `-${s}` : s;
}

function compact(n: number): string {
  const a = Math.abs(n);
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [div, suffix] of units) {
    if (a >= div) return trimNum(n / div, false) + suffix;
  }
  return trimNum(n, false);
}

/** Format a raw number per a ValueFormat enum value. Deterministic. */
export function formatStatNumber(n: number, format: number): string {
  switch (format) {
    case 2: // PERCENT
      return `${trimNum(n, false)}%`;
    case 3: // CURRENCY
      return currency(n);
    case 4: // COMPACT
      return compact(n);
    case 5: // PLAIN
      return trimNum(n, false);
    default: // 0 UNSPECIFIED / 1 NUMBER
      return trimNum(n, true);
  }
}

/** The arrow glyph for a trend (shared so web + tui match). */
export function trendArrow(trend: StatTrend): string {
  return trend === "up" ? "↑" : trend === "down" ? "↓" : trend === "flat" ? "→" : "";
}

/**
 * SVG `<polyline>` points for a sparkline over a width×height box (y-inverted so
 * higher = up). One geometry impl shared by every web kit (html / shadcn / mui /
 * web-components) — drawn by hand, no chart library. "" when < 2 points.
 */
export function statSparklinePoints(series: number[], width = 100, height = 24): string {
  if (series.length < 2) return "";
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * width;
      const y = height - ((v - lo) / span) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function mapTrend(override: number): StatTrend {
  return override === 1 ? "up" : override === 2 ? "down" : override === 3 ? "flat" : "none";
}

/** Compute a StatPanel's value/delta/trend/semantics — the parity-critical core. */
export function computeStat(panel: StatPanel): StatComputed {
  const unitSuffix =
    panel.unit && panel.format !== 2 && panel.format !== 3 ? ` ${panel.unit}` : "";
  const formattedValue = formatStatNumber(panel.value, panel.format) + unitSuffix;

  // Raw delta: value − previous, else last − first of series.
  let raw: number | undefined;
  if (panel.previous !== undefined) raw = panel.value - panel.previous;
  else if (panel.series.length >= 2) raw = panel.series[panel.series.length - 1] - panel.series[0];

  const computedTrend: StatTrend =
    raw === undefined ? "none" : raw > 0 ? "up" : raw < 0 ? "down" : "flat";
  const trend = panel.trendOverride !== 0 ? mapTrend(panel.trendOverride) : computedTrend;

  let formattedDelta: string | null = null;
  if (panel.deltaOverride !== undefined) formattedDelta = panel.deltaOverride;
  else if (raw !== undefined)
    formattedDelta = (raw >= 0 ? "+" : "-") + formatStatNumber(Math.abs(raw), panel.format);

  let semantics: StatSemantics = "neutral";
  if (panel.higherIsBetter !== undefined && (trend === "up" || trend === "down")) {
    const good = (trend === "up") === panel.higherIsBetter;
    semantics = good ? "good" : "bad";
  }

  return {
    formattedValue,
    trend,
    formattedDelta,
    semantics,
    series: panel.series.length >= 2 ? panel.series : [],
  };
}
