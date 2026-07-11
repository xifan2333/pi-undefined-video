/**
 * `uvid draft cutpoints` — episode-level cut-point candidate analysis.
 *
 * Port of the legacy skill script `waveform-report.js`. For every ASR/edit boundary in
 * draft.json this reports energy profile, silence segments, energy trend, RMS jump,
 * zero-crossing offset, local minima, and nearest silence — the numeric evidence the
 * LLM uses to validate/adjust `ranges[]` cut points. Pure measurement, no decisions.
 */
import fs from "node:fs";
import path from "node:path";
import { type Ctx, fail, readJson, rel, resolveExisting, resolvePath, writeJson } from "./util.ts";
import { decodeMonoPcm } from "./proc.ts";

const WINDOW_MS = 50;
const SILENCE_DB = -50;
const SAMPLE_RATE = 48000;

export interface CutpointsParams {
  draft: string;
  output: string;
  source?: string;
  all?: boolean;
}

function rmsDb(samples: Int16Array, start: number, len: number): number {
  let sum = 0;
  const end = Math.min(start + len, samples.length);
  let count = 0;
  for (let i = start; i < end; i++) { sum += samples[i] * samples[i]; count++; }
  if (count === 0) return -96;
  const rms = Math.sqrt(sum / count);
  return rms === 0 ? -96 : 20 * Math.log10(rms / 32768);
}

function findZeroCrossing(samples: Int16Array, centerIdx: number, radius: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  const start = Math.max(1, centerIdx - radius);
  const end = Math.min(samples.length - 1, centerIdx + radius);
  for (let i = start; i < end; i++) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) {
      const dist = Math.abs(i - centerIdx);
      if (dist < bestDist) { best = i; bestDist = dist; }
    }
  }
  return best;
}

const idxToMs = (idx: number, rate: number) => Math.round(idx / rate * 1000);
const msToIdx = (ms: number, rate: number) => Math.floor(ms / 1000 * rate);

function energyTrend(profile: any[], timeMs: number, windowCount: number): any {
  const before = profile.filter((p) => p.timeMs < timeMs).slice(-windowCount);
  const after = profile.filter((p) => p.timeMs >= timeMs).slice(0, windowCount);
  if (before.length < 2 || after.length < 2) return { trend: "unknown", beforeMean: null, afterMean: null, deltaDb: null };
  const beforeMean = before.reduce((s, p) => s + p.rmsDb, 0) / before.length;
  const afterMean = after.reduce((s, p) => s + p.rmsDb, 0) / after.length;
  const delta = afterMean - beforeMean;
  let trend = "flat";
  if (delta > 3) trend = "rising";
  else if (delta < -3) trend = "falling";
  return { trend, beforeMean: Math.round(beforeMean), afterMean: Math.round(afterMean), deltaDb: Math.round(delta) };
}

async function analyzeSource(source: any, edit: any, editDir: string, ctx: Ctx): Promise<any | null> {
  const filePath = path.resolve(editDir, source.path);
  if (!fs.existsSync(filePath)) return null;

  const samples = await decodeMonoPcm(filePath, SAMPLE_RATE, ctx);
  const sampleRate = SAMPLE_RATE;
  const totalMs = idxToMs(samples.length, sampleRate);
  const ws = Math.floor(sampleRate * WINDOW_MS / 1000);

  const energyProfile: any[] = [];
  for (let t = 0; t < totalMs; t += WINDOW_MS) {
    const idx = msToIdx(t, sampleRate);
    energyProfile.push({ timeMs: t, rmsDb: Math.round(rmsDb(samples, idx, ws) * 10) / 10 });
  }

  const silenceSegments: any[] = [];
  let inSilence = false;
  let silenceStart = 0;
  for (const p of energyProfile) {
    if (!inSilence && p.rmsDb < SILENCE_DB) { inSilence = true; silenceStart = p.timeMs; }
    else if (inSilence && p.rmsDb >= SILENCE_DB) {
      const dur = p.timeMs - silenceStart;
      if (dur >= 80) silenceSegments.push({ startMs: silenceStart, endMs: p.timeMs, durationMs: dur });
      inSilence = false;
    }
  }
  if (inSilence) {
    const dur = totalMs - silenceStart;
    if (dur >= 80) silenceSegments.push({ startMs: silenceStart, endMs: totalMs, durationMs: dur });
  }

  const sourceEntries = (edit.entries || []).filter((e: any) => e.source === source.id);
  const boundaries: any[] = [];
  for (const entry of sourceEntries) {
    const entryAction = entry.edit?.action || "keep";
    boundaries.push({ timeMs: entry.startMs, type: "entry_start", id: entry.id, text: entry.text, action: entryAction });
    boundaries.push({ timeMs: entry.endMs, type: "entry_end", id: entry.id, text: entry.text, action: entryAction });
    for (const word of entry.words || []) {
      const wAction = word.edit?.action || "keep";
      boundaries.push({ timeMs: word.startMs, type: "word_start", id: word.id || entry.id + ".w", text: word.text, action: wAction });
      boundaries.push({ timeMs: word.endMs, type: "word_end", id: word.id || entry.id + ".w", text: word.text, action: wAction });
      if (word.gapAfter) {
        const gaAction = word.gapAfter.edit?.action || "keep";
        const keepMs = word.gapAfter.edit?.keepMs;
        boundaries.push({ timeMs: word.gapAfter.endMs, type: "gap_end", id: word.id || entry.id + ".w", text: word.text, action: gaAction, gapKeepMs: keepMs });
        if (gaAction === "trim" && keepMs != null) {
          boundaries.push({ timeMs: word.endMs + keepMs, type: "gap_trim_end", id: word.id || entry.id + ".w", text: word.text, action: "trim_target", gapKeepMs: keepMs });
        }
      }
    }
  }
  boundaries.sort((a, b) => a.timeMs - b.timeMs);

  const cutRadius = msToIdx(200, sampleRate);
  const cutCandidates: any[] = [];
  const analyzed = new Set<number>();

  for (const b of boundaries) {
    if (analyzed.has(b.timeMs)) continue;
    const isRelevant = ["entry_start", "entry_end", "word_start", "word_end", "gap_end", "gap_trim_end"].includes(b.type);
    if (!isRelevant) continue;

    const centerIdx = msToIdx(b.timeMs, sampleRate);
    const winStart = Math.max(0, centerIdx - cutRadius);
    const winEnd = Math.min(samples.length, centerIdx + cutRadius);

    const winEnergies: number[] = [];
    for (let i = winStart; i < winEnd; i += ws) winEnergies.push(rmsDb(samples, i, ws));
    const minDb = winEnergies.length ? Math.round(Math.min(...winEnergies)) : -96;
    const maxDb = winEnergies.length ? Math.round(Math.max(...winEnergies)) : -96;
    const meanDb = winEnergies.length ? Math.round(winEnergies.reduce((a, b2) => a + b2, 0) / winEnergies.length) : -96;

    const beforeDb = rmsDb(samples, Math.max(0, centerIdx - msToIdx(10, sampleRate)), msToIdx(10, sampleRate));
    const afterDb = rmsDb(samples, centerIdx, msToIdx(10, sampleRate));
    const rmsJumpDb = Math.round((afterDb - beforeDb) * 10) / 10;

    const zcIdx = findZeroCrossing(samples, centerIdx, cutRadius);
    const zcMs = zcIdx !== null ? idxToMs(zcIdx, sampleRate) : null;

    const trend = energyTrend(energyProfile, b.timeMs, 5);

    let nearestSilenceDist = Infinity;
    let nearestSilence: any = null;
    for (const s of silenceSegments) {
      const dist = Math.min(Math.abs(b.timeMs - s.startMs), Math.abs(b.timeMs - s.endMs));
      if (dist < nearestSilenceDist) { nearestSilenceDist = dist; nearestSilence = s; }
    }

    let localMinMs = b.timeMs;
    let localMinDb = meanDb;
    const localSearch = msToIdx(50, sampleRate);
    for (let i = Math.max(0, centerIdx - localSearch); i <= Math.min(samples.length - localSearch, centerIdx + localSearch); i += ws) {
      const db = rmsDb(samples, i, ws);
      if (db < localMinDb) { localMinDb = Math.round(db); localMinMs = idxToMs(i, sampleRate); }
    }

    cutCandidates.push({
      timeMs: b.timeMs,
      type: b.type,
      id: b.id,
      text: b.text,
      action: b.action,
      gapKeepMs: b.gapKeepMs || null,
      windowMs: { start: idxToMs(winStart, sampleRate), end: idxToMs(winEnd, sampleRate) },
      energy: { minDb, maxDb, meanDb },
      rmsJumpDb,
      energyTrend: trend,
      zeroCrossing: { atMs: zcMs, offsetMs: zcMs !== null ? zcMs - b.timeMs : null },
      localMin: { atMs: localMinMs, db: localMinDb, offsetMs: localMinMs - b.timeMs },
      nearestSilence: nearestSilence ? { startMs: nearestSilence.startMs, endMs: nearestSilence.endMs, distMs: nearestSilenceDist } : null,
    });

    analyzed.add(b.timeMs);
  }

  return {
    schemaVersion: 1,
    kind: "audio.cutpoints",
    source: source.id,
    file: source.path,
    durationMs: totalMs,
    sampleRate,
    energyProfile,
    silenceSegments,
    boundaries: boundaries.filter((b) => b.timeMs > 0 && b.timeMs < totalMs - 50),
    cutCandidates: cutCandidates.filter((c) => c.timeMs > 50 && c.timeMs < totalMs - 50),
  };
}

/** Analyze cut-point candidates for one or all sources in draft.json; writes waveform-<id>.json per source. */
export async function audioGetCutpoints(p: CutpointsParams, ctx: Ctx): Promise<void> {
  const editPath = resolveExisting(ctx, p.draft, "--draft");
  const outDir = resolvePath(ctx, p.output);
  if (!p.all && !p.source) fail("specify --source ID or --all");
  const edit = readJson(editPath);
  const editDir = path.dirname(editPath);

  let written = 0;
  for (const source of edit.sources || []) {
    if (!p.all && source.id !== p.source) continue;
    const report = await analyzeSource(source, edit, editDir, ctx);
    if (!report) {
      ctx.log(`  source ${source.id}: media not found, skipped (${source.path})`);
      continue;
    }
    const out = path.join(outDir, `waveform-${source.id}.json`);
    writeJson(out, report);
    ctx.log(`  source ${source.id}: ${report.durationMs}ms, ${report.silenceSegments.length} silences, ${report.cutCandidates.length} cut candidates → ${rel(ctx, out)}`);
    written++;
  }
  if (written === 0) fail(`no matching sources in ${p.draft}`);
  ctx.log(`uvid draft cutpoints: wrote ${written} report(s)`);
}
