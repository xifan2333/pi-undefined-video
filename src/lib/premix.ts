/**
 * `uvid draft premix` / `uvid draft splices` — deterministic execution of
 * draft.json cut decisions, plus post-cut numeric splice analysis (the second half of
 * the editing closed loop; see editing reference).
 *
 * Premix semantics (fixed, no new decisions):
 * - The source is decoded once, timestamps are rewritten from the decoded sample count
 *   (asetpts=N/SR/TB) so range times share the ASR/waveform time base regardless of
 *   container edit lists / AAC priming, then ranges[] are trimmed and joined in order.
 * - Join smoothing = prev.out.smoothing ?? next.in.smoothing:
 *     none       → plain concat
 *     crossfade  → acrossfade d=ms (c1=c2=qsin); premix shortens by ms
 *     breath_gap → insert ms of silence, 8ms micro-fades on both adjacent edges
 * - Explicit `fade` smoothing on a range edge → afade on that edge.
 * - Tail: adeclick. Output: mono 48kHz s16 WAV.
 *
 * NOTE: subtitles' sourceLocalStartMs/EndMs must be premix-local times, i.e. include
 * inserted breath gaps and subtract crossfade overlaps. The layout report printed by
 * both commands gives the authoritative premix-local start of every range.
 */
import path from "node:path";
import { type Ctx, ensureDir, fail, outputJson, readJson, rel, resolveExisting, resolvePath } from "./util.ts";
import { decodeMonoPcm, ffmpeg } from "./proc.ts";

const MICRO_FADE_MS = 8;
const AFORMAT = "aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono";

interface JoinInfo {
  index: number;            // join between ranges[index] and ranges[index+1]
  leftRange: string;
  rightRange: string;
  type: "none" | "crossfade" | "breath_gap";
  ms: number;
  /** Premix-local splice time (crossfade: overlap midpoint; gap: gap midpoint). */
  premixMs: number;
}

interface Layout {
  ranges: Array<{ id: string; sourceStartMs: number; sourceEndMs: number; lenMs: number; premixStartMs: number }>;
  joins: JoinInfo[];
  totalMs: number;
}

function findSource(edit: any, sourceId: string): any {
  const src = (edit.sources || []).find((s: any) => s.id === sourceId);
  if (!src) fail(`source not found in draft.json: ${sourceId}`);
  if (!Array.isArray(src.ranges) || src.ranges.length === 0) fail(`source ${sourceId} has no ranges[]`);
  return src;
}

function joinSmoothing(prev: any, next: any): { type: string; ms: number } | null {
  return prev?.out?.smoothing || next?.in?.smoothing || null;
}

/** Compute the premix-local layout implied by ranges[] + smoothing declarations. */
export function computeLayout(src: any): Layout {
  const ranges: Layout["ranges"] = [];
  const joins: JoinInfo[] = [];
  let cursor = 0;
  for (let i = 0; i < src.ranges.length; i++) {
    const r = src.ranges[i];
    const len = r.sourceEndMs - r.sourceStartMs;
    if (!(len > 0)) fail(`range ${r.id}: non-positive length`);
    if (i > 0) {
      const prev = src.ranges[i - 1];
      const sm = joinSmoothing(prev, r);
      if (sm && sm.type === "crossfade") {
        if (sm.ms <= 0) fail(`range ${r.id}: invalid crossfade ms`);
        joins.push({ index: i - 1, leftRange: prev.id, rightRange: r.id, type: "crossfade", ms: sm.ms, premixMs: cursor - Math.round(sm.ms / 2) });
        cursor -= sm.ms; // acrossfade overlaps the tail/head
      } else if (sm && sm.type === "breath_gap") {
        if (sm.ms <= 0) fail(`range ${r.id}: invalid breath_gap ms`);
        joins.push({ index: i - 1, leftRange: prev.id, rightRange: r.id, type: "breath_gap", ms: sm.ms, premixMs: cursor + Math.round(sm.ms / 2) });
        cursor += sm.ms;
      } else {
        joins.push({ index: i - 1, leftRange: prev.id, rightRange: r.id, type: "none", ms: 0, premixMs: cursor });
      }
    }
    ranges.push({ id: r.id, sourceStartMs: r.sourceStartMs, sourceEndMs: r.sourceEndMs, lenMs: len, premixStartMs: cursor });
    cursor += len;
  }
  return { ranges, joins, totalMs: cursor };
}

export interface PremixParams {
  draft: string;
  source: string;
  output: string;
}

/** Render the voice premix WAV for one source from its draft.json ranges. */
export async function audioCreatePremix(p: PremixParams, ctx: Ctx): Promise<void> {
  const editPath = resolveExisting(ctx, p.draft, "--draft");
  const edit = readJson(editPath);
  const src = findSource(edit, p.source);
  const media = path.resolve(path.dirname(editPath), src.path);
  const output = resolvePath(ctx, p.output);
  ensureDir(path.dirname(output));

  const layout = computeLayout(src);
  const lines: string[] = [];

  // Decode once, rewrite timestamps from the decoded sample count (see header note),
  // then split into one branch per range.
  const n = src.ranges.length;
  const splitLabels = Array.from({ length: n }, (_, i) => `[i${i}]`).join("");
  lines.push(`[0:a]${AFORMAT},asetpts=N/SR/TB${n > 1 ? `,asplit=${n}${splitLabels}` : "[i0]"}`);

  // Per-range segments with edge fades.
  for (let i = 0; i < n; i++) {
    const r = src.ranges[i];
    const len = r.sourceEndMs - r.sourceStartMs;
    const prevJoin = i > 0 ? layout.joins[i - 1] : null;
    const nextJoin = i < layout.joins.length ? layout.joins[i] : null;

    let fadeInMs = r.in?.smoothing?.type === "fade" ? r.in.smoothing.ms : 0;
    let fadeOutMs = r.out?.smoothing?.type === "fade" ? r.out.smoothing.ms : 0;
    if (prevJoin?.type === "breath_gap") fadeInMs = Math.max(fadeInMs, MICRO_FADE_MS);
    if (nextJoin?.type === "breath_gap") fadeOutMs = Math.max(fadeOutMs, MICRO_FADE_MS);
    if (nextJoin?.type === "crossfade" && nextJoin.ms >= len) fail(`range ${r.id}: crossfade ${nextJoin.ms}ms >= range length ${len}ms`);

    let chain = `[i${i}]atrim=start=${r.sourceStartMs / 1000}:end=${r.sourceEndMs / 1000},asetpts=PTS-STARTPTS`;
    if (fadeInMs > 0) chain += `,afade=t=in:st=0:d=${fadeInMs / 1000}`;
    if (fadeOutMs > 0) chain += `,afade=t=out:st=${(len - fadeOutMs) / 1000}:d=${fadeOutMs / 1000}`;
    lines.push(`${chain}[s${i}]`);
  }

  // Sequential joins.
  let acc = "s0";
  for (let j = 0; j < layout.joins.length; j++) {
    const join = layout.joins[j];
    const right = `s${join.index + 1}`;
    if (join.type === "crossfade") {
      lines.push(`[${acc}][${right}]acrossfade=d=${join.ms / 1000}:c1=qsin:c2=qsin[j${j}]`);
    } else if (join.type === "breath_gap") {
      lines.push(`anullsrc=r=48000:cl=mono,atrim=duration=${join.ms / 1000},${AFORMAT}[g${j}]`);
      lines.push(`[${acc}][g${j}][${right}]concat=n=3:v=0:a=1[j${j}]`);
    } else {
      lines.push(`[${acc}][${right}]concat=n=2:v=0:a=1[j${j}]`);
    }
    acc = `j${j}`;
  }
  lines.push(`[${acc}]adeclick[out]`);

  await ffmpeg(["-i", media, "-filter_complex", lines.join(";"), "-map", "[out]", "-c:a", "pcm_s16le", output], ctx);

  ctx.log(`uvid draft premix: ${rel(ctx, media)} → ${rel(ctx, output)}`);
  ctx.log(`  ${layout.ranges.length} ranges, ${layout.totalMs}ms total`);
  for (const r of layout.ranges) {
    ctx.log(`  ${r.id}: source ${r.sourceStartMs}..${r.sourceEndMs} → premix-local ${r.premixStartMs}..${r.premixStartMs + r.lenMs}`);
  }
  for (const join of layout.joins) {
    ctx.log(`  splice ${join.leftRange}→${join.rightRange}: ${join.type}${join.ms ? ` ${join.ms}ms` : ""} @ ${join.premixMs}ms`);
  }
}

export interface SplicesParams {
  input: string;
  draft: string;
  source: string;
  output?: string;
}

const SR = 48000;
const msToIdx = (ms: number) => Math.floor(ms / 1000 * SR);

function rmsDbAt(samples: Int16Array, startMs: number, lenMs: number): number {
  const start = Math.max(0, msToIdx(startMs));
  const end = Math.min(samples.length, msToIdx(startMs + lenMs));
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i++) { sum += samples[i] * samples[i]; count++; }
  if (count === 0) return -96;
  const rms = Math.sqrt(sum / count);
  return rms === 0 ? -96 : Number((20 * Math.log10(rms / 32768)).toFixed(1));
}

function peakDbAt(samples: Int16Array, startMs: number, lenMs: number): number {
  const start = Math.max(0, msToIdx(startMs));
  const end = Math.min(samples.length, msToIdx(startMs + lenMs));
  let max = 0;
  for (let i = start; i < end; i++) { const v = Math.abs(samples[i]); if (v > max) max = v; }
  return max === 0 ? -96 : Number((20 * Math.log10(max / 32768)).toFixed(1));
}

/** Zero-crossing rate (crossings per ms) in a window. */
function zcrAt(samples: Int16Array, startMs: number, lenMs: number): number {
  const start = Math.max(1, msToIdx(startMs));
  const end = Math.min(samples.length, msToIdx(startMs + lenMs));
  let crossings = 0;
  for (let i = start; i < end; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings++;
  }
  return Number((crossings / Math.max(1, lenMs)).toFixed(2));
}

function nearestZeroCrossingOffsetMs(samples: Int16Array, atMs: number, radiusMs: number): number | null {
  const center = msToIdx(atMs);
  const radius = msToIdx(radiusMs);
  let best: number | null = null;
  let bestDist = Infinity;
  const start = Math.max(1, center - radius);
  const end = Math.min(samples.length - 1, center + radius);
  for (let i = start; i < end; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) {
      const dist = Math.abs(i - center);
      if (dist < bestDist) { best = i; bestDist = dist; }
    }
  }
  return best === null ? null : Number(((best - center) / SR * 1000).toFixed(2));
}

/**
 * Analyze splice points of a rendered premix. Heuristic hardnessScore ranks the
 * splices most likely to sound harsh (bigger = worse); fix only the worst 3-5.
 */
export async function audioGetSplices(p: SplicesParams, ctx: Ctx): Promise<void> {
  const premixPath = resolveExisting(ctx, p.input, "input");
  const editPath = resolveExisting(ctx, p.draft, "--draft");
  const edit = readJson(editPath);
  const src = findSource(edit, p.source);
  const layout = computeLayout(src);
  const samples = await decodeMonoPcm(premixPath, SR, ctx);
  const durationMs = Math.round(samples.length / SR * 1000);

  const splices = layout.joins.map((join) => {
    const t = join.premixMs;
    const rmsBeforeDb = rmsDbAt(samples, t - 17, 15);
    const rmsAfterDb = rmsDbAt(samples, t + 2, 15);
    const rmsJumpDb = Number((rmsAfterDb - rmsBeforeDb).toFixed(1));
    const peakAroundDb = peakDbAt(samples, t - 10, 20);
    const zcrBefore = zcrAt(samples, t - 22, 20);
    const zcrAfter = zcrAt(samples, t + 2, 20);
    const zeroCrossingOffsetMs = nearestZeroCrossingOffsetMs(samples, t, 20);
    // Heuristic ranking: envelope jump + hot peak + timbre shift; gaps are inherently safer.
    const gapRelief = join.type === "breath_gap" ? 0.4 : 1;
    const hardnessScore = Number((
      (Math.abs(rmsJumpDb) * 1.2 + Math.max(0, peakAroundDb + 9) * 2 + Math.abs(zcrAfter - zcrBefore) * 8) * gapRelief
    ).toFixed(1));
    return {
      timelineMs: t,
      leftRange: join.leftRange,
      rightRange: join.rightRange,
      smoothing: { type: join.type, ms: join.ms },
      rmsBeforeDb,
      rmsAfterDb,
      rmsJumpDb,
      peakAroundDb,
      zcrBefore,
      zcrAfter,
      zeroCrossingOffsetMs,
      hardnessScore,
    };
  }).sort((a, b) => b.hardnessScore - a.hardnessScore);

  outputJson(ctx, {
    schemaVersion: 1,
    kind: "audio.splices",
    input: rel(ctx, premixPath),
    source: p.source,
    durationMs,
    expectedDurationMs: layout.totalMs,
    splices,
  }, p.output);
  ctx.log(`uvid draft splices: ${splices.length} splices, worst hardnessScore ${splices[0]?.hardnessScore ?? 0} (${splices[0] ? `${splices[0].leftRange}→${splices[0].rightRange}` : "n/a"})`);
}
