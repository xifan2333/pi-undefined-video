/**
 * `uvid draft check` — one-shot apply gate for draft.json.
 *
 * Replaces the manual validate → premix → splices → subtitles chain with a single
 * command that writes one summary.json with an actionNeeded list. The editor's loop
 * becomes: edit draft.json → `uvid draft check` → read summary → fix → re-check
 * (incrementally with --source).
 *
 * Also normalizes mechanical range fields before validating: durationMs /
 * sourceLocalStartMs / sourceLocalEndMs are derived from sourceStartMs/sourceEndMs
 * and written back, so the editor only ever writes decisions (which ranges, where
 * in/out land, smoothing) — never arithmetic.
 */
import path from "node:path";
import { type Ctx, ensureDir, fail, readJson, rel, resolveExisting, resolvePath, writeJson } from "./util.ts";
import { draftEvidence, draftSubtitles, draftValidate } from "./draft.ts";
import { audioCreatePremix, audioGetSplices } from "./premix.ts";

/** Default heuristic threshold: splices at or above this hardnessScore land in actionNeeded. */
const DEFAULT_HARD_THRESHOLD = 15;

export interface DraftCheckParams {
  draft: string;
  /** Output directory for summary.json and splice reports. */
  output: string;
  /** Directory where premix WAVs are written as src-<id>.wav (caller's layout, e.g. clips). */
  voiceDir: string;
  /** Re-check one source id only (incremental loop after a fix). */
  source?: string;
  /** Also run visual evidence (contact sheets) for kind=video sources. Slower. */
  evidence?: boolean;
  /** hardnessScore at/above which a splice needs action; default 15. */
  hardThreshold?: number;
}

function errMsg(e: any): string {
  return e?.message || String(e);
}

/**
 * Fill durationMs / sourceLocalStartMs / sourceLocalEndMs from sourceStartMs /
 * sourceEndMs (plain accumulation, same convention as draft subtitles). Returns
 * the number of ranges that were added or corrected.
 */
function normalizeRangeFields(data: any): number {
  let fixed = 0;
  for (const src of Array.isArray(data?.sources) ? data.sources : []) {
    if (!Array.isArray(src?.ranges)) continue;
    let cursor = 0;
    for (const r of src.ranges) {
      const start = r?.sourceStartMs;
      const end = r?.sourceEndMs;
      if (typeof start !== "number" || typeof end !== "number" || end <= start) continue;
      const len = end - start;
      if (r.durationMs !== len || r.sourceLocalStartMs !== cursor || r.sourceLocalEndMs !== cursor + len) {
        r.durationMs = len;
        r.sourceLocalStartMs = cursor;
        r.sourceLocalEndMs = cursor + len;
        fixed++;
      }
      cursor += len;
    }
  }
  return fixed;
}

/** One-shot apply gate: normalize → validate(strict) → premix → splices → subtitles → summary. */
export async function draftCheck(p: DraftCheckParams, ctx: Ctx): Promise<void> {
  const draftPath = resolveExisting(ctx, p.draft, "--draft");
  const voiceDir = resolvePath(ctx, p.voiceDir);
  ensureDir(voiceDir);
  const outDir = resolvePath(ctx, p.output);
  ensureDir(outDir);
  const hardThreshold = p.hardThreshold ?? DEFAULT_HARD_THRESHOLD;

  const summary: any = {
    schemaVersion: 1,
    kind: "draft.check",
    draft: rel(ctx, draftPath),
    source: p.source ?? "all",
    sources: [],
    actionNeeded: [],
  };
  const problems: string[] = [];

  // 0. Normalize mechanical fields so the editor never hand-computes them.
  const data0 = readJson(draftPath);
  const fixed = normalizeRangeFields(data0);
  if (fixed > 0) {
    writeJson(draftPath, data0);
    ctx.log(`uvid draft check: normalized ${fixed} range field set(s) (durationMs/sourceLocal*)`);
  }
  summary.normalizedRanges = fixed;

  // 1. Validate. Full check = strict gate; incremental --source check relaxes to
  // error-only so undecided sibling sources don't block the loop (the final full
  // check before Lock is still strict).
  const strict = p.source === undefined;
  summary.strict = strict;
  try {
    await draftValidate({ input: p.draft, strict }, ctx);
    summary.validate = "pass";
  } catch (e) {
    summary.validate = `fail: ${errMsg(e)}`;
    summary.actionNeeded.push(`validate: ${errMsg(e)}`);
    writeJson(path.join(outDir, "summary.json"), summary);
    ctx.log(`uvid draft check: FAIL (validate) — see ${rel(ctx, path.join(outDir, "summary.json"))}`);
    fail(`draft check failed at validate: ${errMsg(e)}`);
  }

  const data = readJson(draftPath);
  const targets = (data.sources as any[]).filter((s: any) => p.source === undefined || s?.id === p.source);
  if (p.source !== undefined && targets.length === 0) fail(`source not found in draft.json: ${p.source}`);

  // 2. Per source: premix + splices.
  for (const src of targets) {
    const info: any = { id: src.id, kind: src.kind, ranges: Array.isArray(src.ranges) ? src.ranges.length : 0 };
    if (info.ranges === 0) {
      info.premix = "skipped: no ranges[]";
      summary.actionNeeded.push(`${src.id}: no ranges[] — write keep intervals first`);
      summary.sources.push(info);
      continue;
    }

    const wav = path.join(voiceDir, `src-${src.id}.wav`);
    try {
      await audioCreatePremix({ draft: p.draft, source: src.id, output: wav }, ctx);
      info.premix = rel(ctx, wav);
    } catch (e) {
      info.premix = `fail: ${errMsg(e)}`;
      problems.push(`${src.id}: premix failed`);
      summary.actionNeeded.push(`${src.id}: premix failed — ${errMsg(e)}`);
      summary.sources.push(info);
      continue;
    }

    if (info.ranges >= 2) {
      const report = path.join(outDir, `splices-${src.id}.json`);
      try {
        await audioGetSplices({ input: wav, draft: p.draft, source: src.id, output: report }, ctx);
        const rep = readJson(report);
        info.splices = {
          count: rep.splices.length,
          report: rel(ctx, report),
          worst: rep.splices.slice(0, 3).map((s: any) => ({
            join: `${s.leftRange}→${s.rightRange}`,
            atMs: s.timelineMs,
            hardnessScore: s.hardnessScore,
            smoothing: s.smoothing,
          })),
        };
        for (const s of rep.splices.filter((x: any) => x.hardnessScore >= hardThreshold)) {
          summary.actionNeeded.push(
            `${src.id}: hard splice ${s.leftRange}→${s.rightRange} @${s.timelineMs}ms (hardness ${s.hardnessScore}) — consider smoothing or moving the cut into silence`,
          );
        }
      } catch (e) {
        info.splices = `fail: ${errMsg(e)}`;
        problems.push(`${src.id}: splices failed`);
      }
    } else {
      info.splices = "n/a (single range)";
    }
    summary.sources.push(info);
  }

  // 3. Subtitles (derived deterministically; only for sources that have ranges).
  const anyRanges = targets.some((s: any) => Array.isArray(s.ranges) && s.ranges.length > 0);
  if (anyRanges) {
    try {
      await draftSubtitles({ input: p.draft, source: p.source }, ctx);
      summary.subtitles = "written";
    } catch (e) {
      summary.subtitles = `fail: ${errMsg(e)}`;
      problems.push(`subtitles failed`);
      summary.actionNeeded.push(`subtitles: ${errMsg(e)}`);
    }
  } else {
    summary.subtitles = "skipped: no source has ranges";
  }

  // 4. Optional visual evidence for kind=video sources.
  if (p.evidence === true) {
    const videoTargets = targets.filter((s: any) => s.kind === "video" && Array.isArray(s.ranges) && s.ranges.length > 0);
    if (videoTargets.length > 0) {
      const evidenceDir = path.join(outDir, "evidence");
      try {
        await draftEvidence(
          { draft: p.draft, output: evidenceDir, source: p.source !== undefined ? p.source : undefined },
          ctx,
        );
        summary.evidence = rel(ctx, evidenceDir);
      } catch (e) {
        summary.evidence = `fail: ${errMsg(e)}`;
        problems.push("evidence failed");
      }
    } else {
      summary.evidence = "skipped: no kind=video source with ranges in selection";
    }
  }

  writeJson(path.join(outDir, "summary.json"), summary);
  ctx.log(`uvid draft check: wrote ${rel(ctx, path.join(outDir, "summary.json"))}`);

  if (summary.actionNeeded.length > 0) {
    ctx.log(`  actionNeeded (${summary.actionNeeded.length}):`);
    for (const a of summary.actionNeeded) ctx.log(`    - ${a}`);
  }

  if (problems.length > 0) {
    fail(`draft check: ${problems.length} step(s) failed — see summary.json`);
  }
  if (summary.actionNeeded.length > 0) {
    fail(`draft check: ${summary.actionNeeded.length} action(s) needed — see summary.json`);
  }
  ctx.log("  PASS — ready for Lock review");
}
