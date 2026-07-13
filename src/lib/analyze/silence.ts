/**
 * uvid analyze silence — waveform JSON → silence ranges JSON.
 *
 * Editing knobs:
 *   --min-ms / --threshold-db  detect
 *   --pad-ms                   expand each range (safer cut pads)
 *   --from-ms / --to-ms        only report ranges overlapping this window
 *   --max-ranges               cap output (longest first)
 */
import { openFilterIo, readInputJson, writeJsonOutput } from "../io.ts";
import type { WaveformWindow } from "./waveform.ts";
import { type Ctx, fail } from "../util.ts";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface AnalyzeSilenceParams {
  input?: string;
  output?: string;
  minMs?: number;
  thresholdDb?: number;
  /** Expand each silence range by this many ms on both sides (clamped ≥ 0). */
  padMs?: number;
  /** Only keep ranges that overlap [fromMs, toMs). */
  fromMs?: number;
  toMs?: number;
  /** Keep at most N ranges (longest first). */
  maxRanges?: number;
}

function silenceRanges(windows: WaveformWindow[], minSilenceMs: number, silenceDb: number): TimeRange[] {
  const silent = windows.filter((w) => w.rmsDb === null || w.rmsDb <= silenceDb);
  if (silent.length === 0) return [];
  const ranges: TimeRange[] = [];
  let cur: TimeRange | null = null;
  for (const w of silent) {
    if (!cur) {
      cur = { startMs: w.startMs, endMs: w.endMs };
      continue;
    }
    if (w.startMs <= cur.endMs + 1) {
      cur.endMs = w.endMs;
    } else {
      if (cur.endMs - cur.startMs >= minSilenceMs) ranges.push(cur);
      cur = { startMs: w.startMs, endMs: w.endMs };
    }
  }
  if (cur && cur.endMs - cur.startMs >= minSilenceMs) ranges.push(cur);
  return ranges;
}

function padRange(r: TimeRange, padMs: number, mediaEnd?: number): TimeRange {
  if (padMs <= 0) return r;
  return {
    startMs: Math.max(0, r.startMs - padMs),
    endMs: mediaEnd != null ? Math.min(mediaEnd, r.endMs + padMs) : r.endMs + padMs,
  };
}

function overlaps(r: TimeRange, fromMs: number, toMs?: number): boolean {
  if (r.endMs <= fromMs) return false;
  if (toMs != null && r.startMs >= toMs) return false;
  return true;
}

function clipToWindow(r: TimeRange, fromMs: number, toMs?: number): TimeRange {
  return {
    startMs: Math.max(r.startMs, fromMs),
    endMs: toMs != null ? Math.min(r.endMs, toMs) : r.endMs,
  };
}

export async function analyzeSilence(p: AnalyzeSilenceParams, ctx: Ctx): Promise<void> {
  const { input, output } = openFilterIo(ctx, p);
  const raw = await readInputJson(ctx, input);
  const windows: WaveformWindow[] | undefined = raw?.windows;
  if (!Array.isArray(windows)) fail("silence input must be analyze.waveform JSON with windows[]");

  const minMs = p.minMs ?? 300;
  const thresholdDb = p.thresholdDb ?? -40;
  const padMs = p.padMs ?? 0;
  const fromMs = p.fromMs != null ? Math.floor(p.fromMs) : 0;
  const toMs = p.toMs != null ? Math.floor(p.toMs) : undefined;
  const maxRanges = p.maxRanges != null ? Math.floor(p.maxRanges) : undefined;

  if (fromMs < 0) fail(`silence --from-ms must be >= 0, got ${fromMs}`);
  if (toMs != null && toMs <= fromMs) {
    fail(`silence window empty: --from-ms ${fromMs} --to-ms ${toMs}`);
  }
  if (padMs < 0) fail(`silence --pad-ms must be >= 0, got ${padMs}`);

  const mediaEnd =
    typeof raw?.durationMs === "number" && Number.isFinite(raw.durationMs)
      ? (raw.durationMs as number)
      : windows.length
        ? windows[windows.length - 1]!.endMs
        : undefined;

  let ranges = silenceRanges(windows, minMs, thresholdDb).map((r) => padRange(r, padMs, mediaEnd));

  if (fromMs > 0 || toMs != null) {
    ranges = ranges
      .filter((r) => overlaps(r, fromMs, toMs))
      .map((r) => clipToWindow(r, fromMs, toMs))
      .filter((r) => r.endMs > r.startMs);
  }

  if (maxRanges != null && maxRanges > 0 && ranges.length > maxRanges) {
    ranges = [...ranges]
      .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
      .slice(0, maxRanges)
      .sort((a, b) => a.startMs - b.startMs);
  }

  writeJsonOutput(ctx, output, {
    schemaVersion: 1,
    kind: "analyze.silence",
    input: input.label,
    minMs,
    thresholdDb,
    padMs,
    fromMs,
    toMs: toMs ?? null,
    maxRanges: maxRanges ?? null,
    ranges,
  });
}
