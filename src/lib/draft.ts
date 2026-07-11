/**
 * draft.json validation — structure + semantic checks.
 *
 * Path-agnostic: does not require any episode directory layout. When checkFiles is
 * on (default), path/asr are resolved relative to the draft.json directory and only
 * checked for existence.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Ctx, ensureDir, fail, readJson, rel, resolveExisting, resolveAgainst, writeJson, resolvePath } from "./util.ts";
import { decodeMonoPcm, exec, mediaDurationMs } from "./proc.ts";

const KINDS = new Set(["video", "audio"]);
const TIMEBASES = new Set(["source", "timeline"]);
const ENTRY_ACTIONS = new Set(["keep", "cut", "mute", "review"]);
const WORD_ACTIONS = new Set(["keep", "cut", "replace", "review"]);
const GAP_ACTIONS = new Set(["keep", "cut", "trim", "review"]);
const SNAP_TYPES = new Set([
  "silence_midpoint",
  "zero_crossing",
  "local_min",
  "falling_tail",
  "manual",
]);
const SMOOTHING_TYPES = new Set(["none", "fade", "crossfade", "breath_gap", "manual_review"]);

export interface DraftValidateParams {
  input: string;
  /** When true (default), require sources[].path and sources[].asr files to exist. */
  checkFiles?: boolean;
  /** When true, treat warnings as validation failures for pipeline gates. */
  strict?: boolean;
}

type Level = "error" | "warning";

interface Finding {
  level: Level;
  path: string;
  message: string;
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}

function isNonNegInt(n: unknown): n is number {
  return isInt(n) && n >= 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function push(findings: Finding[], level: Level, pth: string, message: string): void {
  findings.push({ level, path: pth, message });
}

function validateSmoothing(findings: Finding[], base: string, sm: unknown): void {
  if (sm === undefined) return;
  if (!isObject(sm)) {
    push(findings, "error", base, "smoothing must be an object");
    return;
  }
  if (typeof sm.type !== "string" || !SMOOTHING_TYPES.has(sm.type)) {
    push(findings, "error", `${base}.type`, `invalid smoothing type: ${String(sm.type)}`);
  }
  if (!isNonNegInt(sm.ms) || sm.ms > 100) {
    push(findings, "error", `${base}.ms`, "smoothing.ms must be an integer 0..100");
  }
}

function validateBoundary(findings: Finding[], base: string, b: unknown): void {
  if (b === undefined) return;
  if (!isObject(b)) {
    push(findings, "error", base, "range boundary must be an object");
    return;
  }
  if (b.snap !== undefined && (typeof b.snap !== "string" || !SNAP_TYPES.has(b.snap))) {
    push(findings, "error", `${base}.snap`, `invalid snap: ${String(b.snap)}`);
  }
  if (b.reason !== undefined && typeof b.reason !== "string") {
    push(findings, "error", `${base}.reason`, "reason must be a string");
  }
  validateSmoothing(findings, `${base}.smoothing`, b.smoothing);
}

function validateRange(findings: Finding[], base: string, r: unknown, seenIds: Set<string>): void {
  if (!isObject(r)) {
    push(findings, "error", base, "range must be an object");
    return;
  }
  if (typeof r.id !== "string" || !r.id) {
    push(findings, "error", `${base}.id`, "range.id is required");
  } else if (seenIds.has(r.id)) {
    push(findings, "error", `${base}.id`, `duplicate range id: ${r.id}`);
  } else {
    seenIds.add(r.id);
  }
  for (const k of ["sourceStartMs", "sourceEndMs", "durationMs", "sourceLocalStartMs", "sourceLocalEndMs"] as const) {
    if (!isNonNegInt(r[k])) {
      push(findings, "error", `${base}.${k}`, `${k} must be a non-negative integer`);
    }
  }
  if (isNonNegInt(r.sourceStartMs) && isNonNegInt(r.sourceEndMs)) {
    if (r.sourceStartMs >= r.sourceEndMs) {
      push(findings, "error", base, `sourceStartMs (${r.sourceStartMs}) must be < sourceEndMs (${r.sourceEndMs})`);
    } else if (isNonNegInt(r.durationMs) && r.durationMs !== r.sourceEndMs - r.sourceStartMs) {
      push(
        findings,
        "error",
        `${base}.durationMs`,
        `durationMs (${r.durationMs}) != sourceEndMs-sourceStartMs (${r.sourceEndMs - r.sourceStartMs})`,
      );
    }
  }
  if (isNonNegInt(r.sourceLocalStartMs) && isNonNegInt(r.sourceLocalEndMs) && r.sourceLocalStartMs > r.sourceLocalEndMs) {
    push(findings, "error", base, "sourceLocalStartMs must be <= sourceLocalEndMs");
  }
  validateBoundary(findings, `${base}.in`, r.in);
  validateBoundary(findings, `${base}.out`, r.out);
  if (r.review !== undefined && typeof r.review !== "boolean") {
    push(findings, "error", `${base}.review`, "review must be boolean");
  }
  if (r.notes !== undefined && typeof r.notes !== "string") {
    push(findings, "error", `${base}.notes`, "notes must be a string");
  }
}

function validateWord(findings: Finding[], base: string, w: unknown): void {
  if (!isObject(w)) {
    push(findings, "error", base, "word must be an object");
    return;
  }
  if (typeof w.text !== "string") push(findings, "error", `${base}.text`, "text is required");
  if (!isNonNegInt(w.startMs)) push(findings, "error", `${base}.startMs`, "startMs must be a non-negative integer");
  if (!isNonNegInt(w.endMs)) push(findings, "error", `${base}.endMs`, "endMs must be a non-negative integer");
  if (isNonNegInt(w.startMs) && isNonNegInt(w.endMs) && w.startMs > w.endMs) {
    push(findings, "error", base, `startMs (${w.startMs}) > endMs (${w.endMs})`);
  }
  if (w.edit !== undefined) {
    if (!isObject(w.edit)) {
      push(findings, "error", `${base}.edit`, "edit must be an object");
    } else {
      const action = w.edit.action ?? "keep";
      if (typeof action !== "string" || !WORD_ACTIONS.has(action)) {
        push(findings, "error", `${base}.edit.action`, `invalid action: ${String(action)}`);
      }
      if (action === "replace" && (typeof w.edit.text !== "string" || !w.edit.text)) {
        push(findings, "error", `${base}.edit.text`, "replace action requires edit.text");
      }
    }
  }
  if (w.gapAfter !== undefined) {
    if (!isObject(w.gapAfter)) {
      push(findings, "error", `${base}.gapAfter`, "gapAfter must be an object");
    } else {
      if (!isNonNegInt(w.gapAfter.endMs)) {
        push(findings, "error", `${base}.gapAfter.endMs`, "endMs must be a non-negative integer");
      }
      if (w.gapAfter.edit !== undefined) {
        if (!isObject(w.gapAfter.edit)) {
          push(findings, "error", `${base}.gapAfter.edit`, "edit must be an object");
        } else {
          const action = w.gapAfter.edit.action ?? "keep";
          if (typeof action !== "string" || !GAP_ACTIONS.has(action)) {
            push(findings, "error", `${base}.gapAfter.edit.action`, `invalid action: ${String(action)}`);
          }
          if (action === "trim" && !isNonNegInt(w.gapAfter.edit.keepMs)) {
            push(findings, "error", `${base}.gapAfter.edit.keepMs`, "trim action requires keepMs");
          }
        }
      }
    }
  }
}

function validateEntry(findings: Finding[], base: string, e: unknown, sourceIds: Set<string>, entryIds: Set<string>): void {
  if (!isObject(e)) {
    push(findings, "error", base, "entry must be an object");
    return;
  }
  if (typeof e.id !== "string" || !e.id) {
    push(findings, "error", `${base}.id`, "id is required");
  } else if (entryIds.has(e.id)) {
    push(findings, "error", `${base}.id`, `duplicate entry id: ${e.id}`);
  } else {
    entryIds.add(e.id);
  }
  if (typeof e.source !== "string" || !e.source) {
    push(findings, "error", `${base}.source`, "source is required");
  } else if (!sourceIds.has(e.source)) {
    push(findings, "error", `${base}.source`, `unknown source id: ${e.source}`);
  }
  if (typeof e.text !== "string") push(findings, "error", `${base}.text`, "text is required");
  if (e.correctedText !== undefined && typeof e.correctedText !== "string") {
    push(findings, "error", `${base}.correctedText`, "correctedText must be a string");
  }
  if (!isNonNegInt(e.startMs)) push(findings, "error", `${base}.startMs`, "startMs must be a non-negative integer");
  if (!isNonNegInt(e.endMs)) push(findings, "error", `${base}.endMs`, "endMs must be a non-negative integer");
  if (isNonNegInt(e.startMs) && isNonNegInt(e.endMs) && e.startMs > e.endMs) {
    push(findings, "error", base, `startMs (${e.startMs}) > endMs (${e.endMs})`);
  }
  if (e.edit !== undefined) {
    if (!isObject(e.edit)) {
      push(findings, "error", `${base}.edit`, "edit must be an object");
    } else {
      const action = e.edit.action ?? "keep";
      if (typeof action !== "string" || !ENTRY_ACTIONS.has(action)) {
        push(findings, "error", `${base}.edit.action`, `invalid action: ${String(action)}`);
      }
    }
  }
  if (!Array.isArray(e.words)) {
    push(findings, "error", `${base}.words`, "words must be an array");
  } else {
    e.words.forEach((w, i) => validateWord(findings, `${base}.words[${i}]`, w));
  }
}

function validateSource(
  findings: Finding[],
  base: string,
  s: unknown,
  sourceIds: Set<string>,
  editPath: string,
  checkFiles: boolean,
): void {
  if (!isObject(s)) {
    push(findings, "error", base, "source must be an object");
    return;
  }
  if (typeof s.id !== "string" || !s.id) {
    push(findings, "error", `${base}.id`, "id is required");
  } else if (sourceIds.has(s.id)) {
    push(findings, "error", `${base}.id`, `duplicate source id: ${s.id}`);
  } else {
    sourceIds.add(s.id);
  }
  if (typeof s.path !== "string" || !s.path) {
    push(findings, "error", `${base}.path`, "path is required");
  } else if (checkFiles) {
    const abs = resolveAgainst(editPath, s.path);
    if (!fs.existsSync(abs)) push(findings, "error", `${base}.path`, `file not found: ${s.path}`);
  }
  if (typeof s.asr !== "string" || !s.asr) {
    push(findings, "error", `${base}.asr`, "asr is required");
  } else if (checkFiles) {
    const abs = resolveAgainst(editPath, s.asr);
    if (!fs.existsSync(abs)) push(findings, "error", `${base}.asr`, `file not found: ${s.asr}`);
  }
  if (typeof s.kind !== "string" || !KINDS.has(s.kind)) {
    push(findings, "error", `${base}.kind`, `kind must be "video" or "audio"`);
  }
  if (s.durationMs !== undefined && !isNonNegInt(s.durationMs)) {
    push(findings, "error", `${base}.durationMs`, "durationMs must be a non-negative integer");
  }

  const ranges = s.ranges;
  if (ranges === undefined) {
    push(findings, "warning", `${base}.ranges`, "ranges missing (needed before premix)");
  } else if (!Array.isArray(ranges)) {
    push(findings, "error", `${base}.ranges`, "ranges must be an array");
  } else if (ranges.length === 0) {
    push(findings, "warning", `${base}.ranges`, "ranges is empty");
  } else {
    const rangeIds = new Set<string>();
    ranges.forEach((r, i) => validateRange(findings, `${base}.ranges[${i}]`, r, rangeIds));

    // overlap + local continuity (only for structurally valid ranges)
    const valid = ranges.filter(
      (r): r is Record<string, number | string | object> =>
        isObject(r) &&
        isNonNegInt(r.sourceStartMs) &&
        isNonNegInt(r.sourceEndMs) &&
        r.sourceStartMs < r.sourceEndMs,
    );
    const ordered = [...valid].sort(
      (a, b) => (a.sourceStartMs as number) - (b.sourceStartMs as number),
    );
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if ((cur.sourceStartMs as number) < (prev.sourceEndMs as number)) {
        push(
          findings,
          "error",
          `${base}.ranges`,
          `overlapping ranges ${String(prev.id)} [${prev.sourceStartMs},${prev.sourceEndMs}) and ${String(cur.id)} [${cur.sourceStartMs},${cur.sourceEndMs})`,
        );
      }
    }
    if (valid.length > 0 && isNonNegInt(valid[0].sourceLocalStartMs) && valid[0].sourceLocalStartMs !== 0) {
      push(findings, "warning", `${base}.ranges[0].sourceLocalStartMs`, "first range local start is usually 0");
    }
    for (let i = 1; i < valid.length; i++) {
      const prev = valid[i - 1];
      const cur = valid[i];
      if (
        isNonNegInt(prev.sourceLocalEndMs) &&
        isNonNegInt(cur.sourceLocalStartMs) &&
        cur.sourceLocalStartMs !== prev.sourceLocalEndMs
      ) {
        push(
          findings,
          "warning",
          `${base}.ranges`,
          `local time gap/jump between ${String(prev.id)} end ${prev.sourceLocalEndMs} and ${String(cur.id)} start ${cur.sourceLocalStartMs}`,
        );
      }
    }
    if (isNonNegInt(s.durationMs)) {
      for (const r of valid) {
        if ((r.sourceEndMs as number) > s.durationMs) {
          push(
            findings,
            "error",
            `${base}.ranges`,
            `range ${String(r.id)} sourceEndMs ${r.sourceEndMs} exceeds source durationMs ${s.durationMs}`,
          );
        }
      }
    }
  }

  const subs = s.subtitles;
  if (subs === undefined) {
    push(findings, "warning", `${base}.subtitles`, "subtitles missing (needed before timeline/dialog)");
  } else if (!Array.isArray(subs)) {
    push(findings, "error", `${base}.subtitles`, "subtitles must be an array");
  } else {
    subs.forEach((sub, i) => {
      const sb = `${base}.subtitles[${i}]`;
      if (!isObject(sub)) {
        push(findings, "error", sb, "subtitle must be an object");
        return;
      }
      for (const k of ["id", "source", "text"] as const) {
        if (typeof sub[k] !== "string" || !sub[k]) push(findings, "error", `${sb}.${k}`, `${k} is required`);
      }
      if (typeof sub.source === "string" && typeof s.id === "string" && sub.source !== s.id) {
        push(findings, "error", `${sb}.source`, `subtitle source "${sub.source}" != parent source "${s.id}"`);
      }
      if (!isNonNegInt(sub.sourceLocalStartMs)) {
        push(findings, "error", `${sb}.sourceLocalStartMs`, "must be a non-negative integer");
      }
      if (!isNonNegInt(sub.sourceLocalEndMs)) {
        push(findings, "error", `${sb}.sourceLocalEndMs`, "must be a non-negative integer");
      }
      if (
        isNonNegInt(sub.sourceLocalStartMs) &&
        isNonNegInt(sub.sourceLocalEndMs) &&
        sub.sourceLocalStartMs > sub.sourceLocalEndMs
      ) {
        push(findings, "error", sb, "sourceLocalStartMs must be <= sourceLocalEndMs");
      }
    });
  }
}

/** Validate draft.json structure and semantics. Throws UvidError when any error-level finding exists. */
export async function draftValidate(p: DraftValidateParams, ctx: Ctx): Promise<void> {
  const editPath = resolveExisting(ctx, p.input, "--input");
  const checkFiles = p.checkFiles !== false;
  const strict = p.strict === true;
  const data = readJson(editPath);
  const findings: Finding[] = [];

  if (!isObject(data)) {
    fail(`draft.json root must be an object: ${rel(ctx, editPath)}`);
  }

  if (data.schemaVersion !== 1) {
    push(findings, "error", "schemaVersion", `expected 1, got ${String(data.schemaVersion)}`);
  }
  if (typeof data.timebase !== "string" || !TIMEBASES.has(data.timebase)) {
    push(findings, "error", "timebase", `must be "source" or "timeline", got ${String(data.timebase)}`);
  }
  if (data.episode !== undefined && typeof data.episode !== "string") {
    push(findings, "error", "episode", "episode must be a string when present");
  }
  if (data.$schema === undefined) {
    push(findings, "warning", "$schema", "missing $schema (IDE validation will be weaker)");
  }

  const sourceIds = new Set<string>();
  if (!Array.isArray(data.sources)) {
    push(findings, "error", "sources", "sources must be an array");
  } else if (data.sources.length === 0) {
    push(findings, "error", "sources", "sources is empty");
  } else {
    data.sources.forEach((s, i) => validateSource(findings, `sources[${i}]`, s, sourceIds, editPath, checkFiles));
  }

  const entryIds = new Set<string>();
  if (!Array.isArray(data.entries)) {
    push(findings, "error", "entries", "entries must be an array");
  } else {
    data.entries.forEach((e, i) => validateEntry(findings, `entries[${i}]`, e, sourceIds, entryIds));
  }

  // Cross-check: every keep/mute entry should ideally map into some range (warning only)
  if (Array.isArray(data.sources) && Array.isArray(data.entries)) {
    const rangesBySource = new Map<string, Array<{ start: number; end: number }>>();
    for (const s of data.sources) {
      if (!isObject(s) || typeof s.id !== "string" || !Array.isArray(s.ranges)) continue;
      const list: Array<{ start: number; end: number }> = [];
      for (const r of s.ranges) {
        if (isObject(r) && isNonNegInt(r.sourceStartMs) && isNonNegInt(r.sourceEndMs)) {
          list.push({ start: r.sourceStartMs, end: r.sourceEndMs });
        }
      }
      rangesBySource.set(s.id, list);
    }
    data.entries.forEach((e, i) => {
      if (!isObject(e) || typeof e.source !== "string") return;
      const action = isObject(e.edit) ? (e.edit.action ?? "keep") : "keep";
      if (action === "cut") return;
      if (!isNonNegInt(e.startMs) || !isNonNegInt(e.endMs)) return;
      const ranges = rangesBySource.get(e.source);
      if (!ranges || ranges.length === 0) return;
      const covered = ranges.some((r) => e.startMs < r.end && e.endMs > r.start);
      if (!covered) {
        push(
          findings,
          "warning",
          `entries[${i}]`,
          `entry ${String(e.id)} (${e.startMs}-${e.endMs}) is not cut but does not overlap any range of source ${e.source}`,
        );
      }
    });
  }

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warning");

  ctx.log(`uvid draft validate: ${rel(ctx, editPath)}`);
  ctx.log(`  sources: ${Array.isArray(data.sources) ? data.sources.length : 0}`);
  ctx.log(`  entries: ${Array.isArray(data.entries) ? data.entries.length : 0}`);
  ctx.log(`  checkFiles: ${checkFiles}`);
  ctx.log(`  strict: ${strict}`);
  ctx.log(`  errors: ${errors.length}, warnings: ${warnings.length}`);

  for (const f of findings) {
    ctx.log(`  ${f.level.toUpperCase()}  ${f.path}: ${f.message}`);
  }

  if (errors.length > 0 || (strict && warnings.length > 0)) {
    fail(`edit validate failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
  }
  if (warnings.length === 0) {
    ctx.log("  OK");
  } else {
    ctx.log(`  OK with ${warnings.length} warning(s)`);
  }
}

export interface DraftSubtitlesParams {
  input: string;
  /** Derive for one source id only; default: all sources. */
  source?: string;
  /** When true, report what would be written without modifying draft.json. */
  dryRun?: boolean;
}

/** Map a source-time ms to compressed premix-local ms by accumulating kept ranges. */
function sourceToLocal(sourceMs: number, ranges: Array<{ start: number; end: number }>): number {
  let acc = 0;
  for (const r of ranges) {
    if (sourceMs <= r.start) return acc;
    if (sourceMs >= r.end) {
      acc += r.end - r.start;
      continue;
    }
    return acc + (sourceMs - r.start);
  }
  return acc;
}

/**
 * Derive sources[].subtitles deterministically from kept entries + ranges:
 * text = correctedText, else post-cut words joined (replace applied);
 * times = range-compressed sourceLocal ms. Entries fully outside kept ranges are skipped.
 */
export async function draftSubtitles(p: DraftSubtitlesParams, ctx: Ctx): Promise<void> {
  const editPath = resolveExisting(ctx, p.input, "--input");
  const data = readJson(editPath);
  if (!isObject(data) || !Array.isArray(data.sources) || !Array.isArray(data.entries)) {
    fail("draft.json must have sources[] and entries[] (run `uvid draft validate` first)");
  }

  const targets = (data.sources as any[]).filter(
    (s) => isObject(s) && typeof s.id === "string" && (p.source === undefined || s.id === p.source),
  );
  if (p.source !== undefined && targets.length === 0) fail(`source not found in draft.json: ${p.source}`);

  ctx.log(`uvid draft subtitles: ${rel(ctx, editPath)}`);
  let wroteAny = false;

  for (const src of targets) {
    const ranges: Array<{ start: number; end: number }> = (Array.isArray(src.ranges) ? src.ranges : [])
      .filter((r: any) => isObject(r) && isNonNegInt(r.sourceStartMs) && isNonNegInt(r.sourceEndMs))
      .map((r: any) => ({ start: r.sourceStartMs as number, end: r.sourceEndMs as number }))
      .sort((a: { start: number }, b: { start: number }) => a.start - b.start);
    if (ranges.length === 0) {
      ctx.log(`  ${src.id}: no valid ranges, skipped`);
      continue;
    }
    const totalLocalMs = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);

    const entries = (data.entries as any[]).filter(
      (e) => isObject(e) && e.source === src.id && !(isObject(e.edit) && e.edit.action === "cut"),
    );

    const subtitles: any[] = [];
    let skipped = 0;
    for (const en of entries) {
      let text: string = typeof en.correctedText === "string" ? en.correctedText : "";
      if (!text && Array.isArray(en.words)) {
        text = en.words
          .filter((w: any) => !(isObject(w?.edit) && w.edit.action === "cut"))
          .map((w: any) =>
            isObject(w?.edit) && w.edit.action === "replace" && typeof w.edit.text === "string"
              ? w.edit.text
              : String(w?.text ?? ""),
          )
          .join("");
      }
      text = text.trim();
      if (!text) {
        skipped += 1;
        continue;
      }
      const localStart = sourceToLocal(en.startMs, ranges);
      const localEnd = Math.min(sourceToLocal(en.endMs, ranges), totalLocalMs);
      if (localEnd <= localStart) {
        skipped += 1;
        continue; // entry lies entirely inside cut intervals
      }
      subtitles.push({
        id: en.id,
        source: src.id,
        text,
        sourceLocalStartMs: localStart,
        sourceLocalEndMs: localEnd,
        originalStartMs: en.startMs,
        originalEndMs: en.endMs,
      });
    }

    src.subtitles = subtitles;
    wroteAny = true;
    ctx.log(
      `  ${src.id}: ${subtitles.length} subtitles (skipped ${skipped}), local 0..${totalLocalMs}ms`,
    );
  }

  if (!wroteAny) fail("no subtitles derived (no target source had valid ranges)");
  if (p.dryRun) {
    ctx.log("  dry-run: draft.json not modified");
    return;
  }
  writeJson(editPath, data);
  ctx.log(`  wrote ${rel(ctx, editPath)}`);
}

/** Absolute path to the package-shipped draft.json schema (for docs / tooling). */
export function draftSchemaPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas/draft.schema.json");
}

// --- visual evidence ---

export interface DraftEvidenceParams {
  /** draft.json path. Existing ranges are treated as candidate edit decisions. */
  draft: string;
  /** Output evidence directory. */
  output: string;
  /** Optional source id filter. */
  source?: string;
  /** Look back before candidate out, ms. Default 500. */
  preMs?: number;
  /** Look ahead after candidate out, ms. Default 4000. */
  postMs?: number;
  /** Settle buffer after last visual change, ms. Default 400. */
  settleMs?: number;
  /** ffmpeg scene threshold. Default 0.0001 for terminal/screen recordings. */
  sceneThreshold?: number;
  /** Generate montage contact sheets. Default true. */
  contactSheets?: boolean;
}

function asInt(v: unknown, fallback: number, name: string): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`${name} must be a non-negative number`);
  return Math.round(n);
}

function asThreshold(v: unknown): number {
  if (v === undefined || v === null) return 0.0001;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) fail("sceneThreshold must be > 0");
  return n;
}

function safeMs(ms: number): number {
  return Math.max(0, Math.round(ms));
}

function frameName(prefix: string, label: string, ms: number): string {
  return `${prefix}-${label}-${safeMs(ms)}ms.png`;
}

async function extractFrame(video: string, ms: number, out: string, ctx: Ctx): Promise<void> {
  ensureDir(path.dirname(out));
  await exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-ss", (Math.max(0, ms) / 1000).toFixed(3),
    "-i", video,
    "-frames:v", "1",
    out,
  ], { signal: ctx.signal, timeoutMs: 60 * 1000 });
}

async function detectSceneChanges(video: string, startMs: number, endMs: number, threshold: number, ctx: Ctx): Promise<Array<{ ms: number; score: number | null }>> {
  const durationMs = Math.max(40, endMs - startMs);
  const vf = `select='gt(scene,${threshold})',metadata=print`;
  const { stderr, stdout } = await exec("ffmpeg", [
    "-hide_banner", "-v", "info",
    "-ss", (startMs / 1000).toFixed(3),
    "-t", (durationMs / 1000).toFixed(3),
    "-i", video,
    "-vf", vf,
    "-an", "-f", "null", "-",
  ], { signal: ctx.signal, timeoutMs: 2 * 60 * 1000 });
  const text = stderr + stdout;
  const pts = [...text.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));
  const scores = [...text.matchAll(/lavfi\.scene_score=([0-9.]+)/g)].map((m) => Number(m[1]));
  return pts.map((p, i) => ({ ms: safeMs(startMs + p * 1000), score: Number.isFinite(scores[i]) ? scores[i] : null }));
}

function entriesOverlapping(edit: any, sourceId: string, startMs: number, endMs: number): any[] {
  return (Array.isArray(edit.entries) ? edit.entries : [])
    .filter((en: any) => isObject(en) && en.source === sourceId && Number(en.startMs) < endMs && Number(en.endMs) > startMs)
    .map((en: any) => ({
      id: en.id,
      startMs: en.startMs,
      endMs: en.endMs,
      action: isObject(en.edit) && typeof en.edit.action === "string" ? en.edit.action : "keep",
      text: typeof en.correctedText === "string" ? en.correctedText : en.text,
    }));
}

async function montage(files: string[], output: string, ctx: Ctx): Promise<void> {
  if (files.length === 0) return;
  ensureDir(path.dirname(output));
  await exec("montage", [
    "-label", "%f",
    ...files,
    "-tile", "4x",
    "-geometry", "+10+70",
    "-background", "#222",
    "-fill", "white",
    "-pointsize", "28",
    output,
  ], { signal: ctx.signal, timeoutMs: 2 * 60 * 1000 });
}

export async function draftEvidence(p: DraftEvidenceParams, ctx: Ctx): Promise<void> {
  const editPath = resolveExisting(ctx, p.draft, "--draft");
  const editDir = path.dirname(editPath);
  const outDir = path.resolve(ctx.cwd, p.output);
  const preMs = asInt(p.preMs, 500, "preMs");
  const postMs = asInt(p.postMs, 4000, "postMs");
  const settleMs = asInt(p.settleMs, 400, "settleMs");
  const threshold = asThreshold(p.sceneThreshold);
  const makeSheets = p.contactSheets !== false;

  const edit = readJson(editPath);
  if (!isObject(edit) || !Array.isArray(edit.sources)) fail("draft.json must have sources[]");
  const sources = edit.sources.filter((s: any) => isObject(s) && s.kind === "video" && (p.source === undefined || s.id === p.source));
  if (p.source !== undefined && sources.length === 0) fail(`video source not found in draft.json: ${p.source}`);

  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  const rangeReport: any[] = [];
  const spliceReport: any[] = [];
  const createdSheets: string[] = [];

  for (const src of sources) {
    if (typeof src.id !== "string" || typeof src.path !== "string") continue;
    if (!Array.isArray(src.ranges) || src.ranges.length === 0) continue;
    const videoPath = path.isAbsolute(src.path) ? src.path : path.resolve(editDir, src.path);
    if (!fs.existsSync(videoPath)) fail(`source video does not exist for ${src.id}: ${src.path}`);

    const sourceDir = path.join(outDir, src.id);
    ensureDir(sourceDir);
    const ranges = [...src.ranges].filter(isObject).sort((a: any, b: any) => a.sourceStartMs - b.sourceStartMs);

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const next = ranges[i + 1];
      if (!Number.isFinite(r.sourceStartMs) || !Number.isFinite(r.sourceEndMs)) continue;
      const searchStart = Math.max(r.sourceStartMs, r.sourceEndMs - preMs);
      const naturalEnd = Math.min(Number(src.durationMs ?? r.sourceEndMs + postMs), r.sourceEndMs + postMs);
      const boundedEnd = next && Number.isFinite(next.sourceStartMs)
        ? Math.min(naturalEnd, Math.max(r.sourceEndMs, next.sourceStartMs - 40))
        : naturalEnd;
      const changes = await detectSceneChanges(videoPath, searchStart, boundedEnd, threshold, ctx);
      const afterOut = changes.filter((c) => c.ms >= r.sourceEndMs);
      const lastChange = afterOut.length ? afterOut[afterOut.length - 1].ms : r.sourceEndMs;
      const candidate = safeMs(Math.min(boundedEnd, Math.max(r.sourceEndMs, lastChange + settleMs)));
      const overlapping = entriesOverlapping(edit, src.id, r.sourceEndMs, candidate);
      const cutSpeechOverlap = overlapping.filter((en) => en.action === "cut");
      const flags = [
        candidate >= boundedEnd && boundedEnd > r.sourceEndMs ? "candidate_at_window_end" : null,
        cutSpeechOverlap.length ? "overlaps_cut_speech" : null,
        afterOut.length ? null : "no_visual_change_after_out",
      ].filter(Boolean);

      const prefix = `${src.id}-${String(r.id)}`;
      const frames = [
        { label: "A-current-tail", ms: Math.max(r.sourceStartMs, r.sourceEndMs - 40) },
        { label: "B-last-change", ms: lastChange },
        { label: "C-candidate", ms: candidate },
        { label: "D-window-end", ms: boundedEnd },
      ];
      for (const f of frames) {
        const file = path.join(sourceDir, frameName(prefix, f.label, f.ms));
        await extractFrame(videoPath, f.ms, file, ctx);
        (f as any).file = path.relative(outDir, file);
      }

      rangeReport.push({
        source: src.id,
        range: r.id,
        currentOutMs: r.sourceEndMs,
        nextRangeStartMs: next?.sourceStartMs ?? null,
        searchWindowMs: [searchStart, boundedEnd],
        changePointsAfterOut: afterOut,
        lastChangeMs: lastChange,
        candidateOutMs: candidate,
        deltaMs: candidate - r.sourceEndMs,
        speechOverlap: overlapping,
        cutSpeechOverlap,
        flags,
        frames: frames.map((f: any) => ({ label: f.label, ms: safeMs(f.ms), file: f.file })),
      });
    }

    for (let i = 0; i < ranges.length - 1; i++) {
      const left = ranges[i];
      const right = ranges[i + 1];
      if (!Number.isFinite(left.sourceEndMs) || !Number.isFinite(right.sourceStartMs)) continue;
      const splice = `${src.id}-${String(left.id)}-to-${String(right.id)}`;
      const frames = [
        { label: "S-A-prev-tail-400", ms: Math.max(left.sourceStartMs, left.sourceEndMs - 400) },
        { label: "S-B-prev-tail", ms: Math.max(left.sourceStartMs, left.sourceEndMs - 40) },
        { label: "S-C-next-head", ms: right.sourceStartMs },
        { label: "S-D-next-head-plus-400", ms: Math.min(Number(src.durationMs ?? right.sourceStartMs + 400), right.sourceStartMs + 400) },
      ];
      for (const f of frames) {
        const file = path.join(sourceDir, frameName(splice, f.label, f.ms));
        await extractFrame(videoPath, f.ms, file, ctx);
        (f as any).file = path.relative(outDir, file);
      }
      const gapEntries = entriesOverlapping(edit, src.id, left.sourceEndMs, right.sourceStartMs);
      spliceReport.push({
        source: src.id,
        splice,
        leftRange: left.id,
        rightRange: right.id,
        leftOutMs: left.sourceEndMs,
        rightInMs: right.sourceStartMs,
        gapMs: right.sourceStartMs - left.sourceEndMs,
        cutSpeechInGap: gapEntries.filter((en) => en.action === "cut"),
        keptSpeechInGap: gapEntries.filter((en) => en.action !== "cut"),
        frames: frames.map((f: any) => ({ label: f.label, ms: safeMs(f.ms), file: f.file })),
      });
    }

    if (makeSheets) {
      const allPng = fs.readdirSync(sourceDir).filter((f) => f.endsWith(".png") && !f.startsWith("contact-sheet-")).sort();
      const rangeFiles = allPng.filter((f) => !f.includes("-S-"));
      const spliceFiles = allPng.filter((f) => f.includes("-S-"));
      if (rangeFiles.length) {
        const out = path.join(sourceDir, `contact-sheet-range-out-${src.id}-original.png`);
        await montage(rangeFiles.map((f) => path.join(sourceDir, f)), out, ctx);
        createdSheets.push(path.relative(ctx.cwd, out));
      }
      if (spliceFiles.length) {
        const out = path.join(sourceDir, `contact-sheet-splice-${src.id}-original.png`);
        await montage(spliceFiles.map((f) => path.join(sourceDir, f)), out, ctx);
        createdSheets.push(path.relative(ctx.cwd, out));
      }
    }
  }

  const params = { draft: path.relative(ctx.cwd, editPath), preMs, postMs, settleMs, sceneThreshold: threshold, source: p.source ?? null };
  const summary = {
    schemaVersion: 1,
    kind: "draft.evidence",
    params,
    sources: sources.map((s: any) => s.id),
    rangeReport,
    spliceReport,
    contactSheets: createdSheets,
  };
  writeJson(path.join(outDir, "summary.json"), summary);
  writeJson(path.join(outDir, "range-out-report.json"), rangeReport);
  writeJson(path.join(outDir, "splice-report.json"), spliceReport);

  ctx.log(`uvid draft evidence: wrote ${rel(ctx, outDir)}`);
  ctx.log(`  video sources: ${sources.length}`);
  ctx.log(`  range out checks: ${rangeReport.length}`);
  ctx.log(`  splice checks: ${spliceReport.length}`);
  ctx.log(`  contact sheets: ${createdSheets.length}`);
  for (const s of createdSheets) ctx.log(`    ${s}`);
}

// --- pre-draft survey (no draft.json required) ---

export interface DraftSurveyParams {
  /** script.md path (media list + video/audio kinds). */
  script: string;
  /** Directory with normalized clips/NN.mp4 */
  clipsDir: string;
  /** Directory with ASR json .uvid-cache/asr/NN.json */
  asrDir: string;
  /** Output survey directory */
  output: string;
  /** Optional single source id */
  source?: string;
}

function parseScriptSources(scriptPath: string): Array<{ id: string; kind: "video" | "audio"; rawSrc: string }> {
  const text = fs.readFileSync(scriptPath, "utf8");
  const out: Array<{ id: string; kind: "video" | "audio"; rawSrc: string }> = [];
  const re = /<(video|audio)\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kind = m[1].toLowerCase() === "video" ? "video" : "audio";
    const rawSrc = m[2];
    const base = path.basename(rawSrc).replace(/\.[^.]+$/, "");
    if (!base) continue;
    if (out.some((x) => x.id === base)) continue;
    out.push({ id: base, kind, rawSrc });
  }
  return out;
}

function loadAsrEntries(asrPath: string, sourceId: string): any[] {
  if (!fs.existsSync(asrPath)) return [];
  const asr = readJson(asrPath);
  // Support common shapes: { entries: [...] } or { segments: [...] } or array
  const list = Array.isArray(asr)
    ? asr
    : Array.isArray(asr.entries)
      ? asr.entries
      : Array.isArray(asr.segments)
        ? asr.segments
        : Array.isArray(asr.utterances)
          ? asr.utterances
          : [];
  return list.map((e: any, i: number) => {
    const startMs = Math.round(Number(e.startMs ?? e.start_ms ?? (e.start != null ? e.start * 1000 : 0)));
    const endMs = Math.round(Number(e.endMs ?? e.end_ms ?? (e.end != null ? e.end * 1000 : startMs)));
    const text = String(e.text ?? e.transcript ?? "");
    const words = Array.isArray(e.words)
      ? e.words.map((w: any) => ({
          text: String(w.text ?? w.word ?? ""),
          startMs: Math.round(Number(w.startMs ?? w.start_ms ?? (w.start != null ? w.start * 1000 : startMs))),
          endMs: Math.round(Number(w.endMs ?? w.end_ms ?? (w.end != null ? w.end * 1000 : endMs))),
        }))
      : [];
    return {
      id: e.id || `${sourceId}.s${String(i + 1).padStart(3, "0")}`,
      source: sourceId,
      text,
      startMs,
      endMs,
      words,
    };
  });
}

async function surveyAudioReport(mediaPath: string, entries: any[], ctx: Ctx): Promise<any> {
  const samples = await decodeMonoPcm(mediaPath, 48000, ctx);
  const sampleRate = 48000;
  const totalMs = Math.round(samples.length / sampleRate * 1000);
  const WINDOW_MS = 50;
  const SILENCE_DB = -50;
  const ws = Math.floor(sampleRate * WINDOW_MS / 1000);
  const rmsAt = (ms: number) => {
    const idx = Math.floor(ms / 1000 * sampleRate);
    let sum = 0;
    let count = 0;
    const end = Math.min(idx + ws, samples.length);
    for (let i = idx; i < end; i++) {
      sum += samples[i] * samples[i];
      count++;
    }
    if (count === 0) return -96;
    const rms = Math.sqrt(sum / count);
    return rms === 0 ? -96 : Math.round(20 * Math.log10(rms / 32768) * 10) / 10;
  };
  const energyProfile: Array<{ timeMs: number; rmsDb: number }> = [];
  for (let t = 0; t < totalMs; t += WINDOW_MS) {
    energyProfile.push({ timeMs: t, rmsDb: rmsAt(t) });
  }
  const silenceSegments: any[] = [];
  let inSilence = false;
  let silenceStart = 0;
  for (const p of energyProfile) {
    if (!inSilence && p.rmsDb < SILENCE_DB) {
      inSilence = true;
      silenceStart = p.timeMs;
    } else if (inSilence && p.rmsDb >= SILENCE_DB) {
      const dur = p.timeMs - silenceStart;
      if (dur >= 80) silenceSegments.push({ startMs: silenceStart, endMs: p.timeMs, durationMs: dur });
      inSilence = false;
    }
  }
  if (inSilence) {
    const dur = totalMs - silenceStart;
    if (dur >= 80) silenceSegments.push({ startMs: silenceStart, endMs: totalMs, durationMs: dur });
  }
  const nearestSilence = (ms: number) => {
    let best: any = null;
    let bestDist = Infinity;
    for (const s of silenceSegments) {
      if (ms >= s.startMs && ms <= s.endMs) return { ...s, relation: "inside" };
      const d = ms < s.startMs ? s.startMs - ms : ms - s.endMs;
      if (d < bestDist) {
        bestDist = d;
        best = { ...s, relation: ms < s.startMs ? "before" : "after", distMs: d };
      }
    }
    return best;
  };
  return {
    durationMs: totalMs,
    silenceSegments,
    entries: entries.map((e) => ({
      id: e.id,
      startMs: e.startMs,
      endMs: e.endMs,
      text: e.text,
      rmsAtStartDb: rmsAt(e.startMs),
      rmsAtEndDb: rmsAt(e.endMs),
      silenceNearStart: nearestSilence(e.startMs),
      silenceNearEnd: nearestSilence(e.endMs),
      // hint for video: look past speech end for visual settle
      visualProbeMs: [e.endMs, Math.min(totalMs, e.endMs + 500), Math.min(totalMs, e.endMs + 1000), Math.min(totalMs, e.endMs + 2000)],
    })),
  };
}

/**
 * Pre-draft survey: script + clips + asr → reports for the editor to write draft.json.
 * Does NOT require draft.json.
 */
export async function draftSurvey(p: DraftSurveyParams, ctx: Ctx): Promise<void> {
  const scriptPath = resolveExisting(ctx, p.script, "--script");
  const clipsDir = resolveExisting(ctx, p.clipsDir, "--clips-dir");
  const asrDir = resolveExisting(ctx, p.asrDir, "--asr-dir");
  const outDir = resolvePath(ctx, p.output);
  const sources = parseScriptSources(scriptPath).filter((s) => p.source === undefined || s.id === p.source);
  if (sources.length === 0) fail("no media sources found in script (or --source filter empty)");

  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  const index: any[] = [];

  for (const src of sources) {
    const mediaPath = path.join(clipsDir, `${src.id}.mp4`);
    const alt = fs.readdirSync(clipsDir).find((f) => f.startsWith(`${src.id}.`) && !f.startsWith("src-"));
    const resolvedMedia = fs.existsSync(mediaPath) ? mediaPath : alt ? path.join(clipsDir, alt) : null;
    if (!resolvedMedia) {
      ctx.log(`  ${src.id}: missing clip in ${rel(ctx, clipsDir)}, skipped`);
      continue;
    }
    const asrPath = path.join(asrDir, `${src.id}.json`);
    const entries = loadAsrEntries(asrPath, src.id);
    const audio = await surveyAudioReport(resolvedMedia, entries, ctx);
    const sourceDir = path.join(outDir, src.id);
    ensureDir(sourceDir);
    const frameFiles: string[] = [];
    if (src.kind === "video") {
      // For each ASR sentence end: end / +500 / +1000 / +2000 — AI chooses visual out
      for (const e of audio.entries) {
        for (const ms of e.visualProbeMs) {
          const label = `${e.id}-at-${ms}ms`;
          const file = path.join(sourceDir, `${label}.png`);
          await extractFrame(resolvedMedia, ms, file, ctx);
          frameFiles.push(file);
        }
      }
      if (frameFiles.length) {
        const sheet = path.join(sourceDir, `contact-sheet-${src.id}-survey-original.png`);
        await montage(frameFiles, sheet, ctx);
      }
    }
    const report = {
      schemaVersion: 1,
      kind: "draft.survey.source",
      id: src.id,
      mediaKind: src.kind,
      rawSrc: src.rawSrc,
      clipPath: path.relative(path.dirname(scriptPath), resolvedMedia).replace(/\\/g, "/"),
      asrPath: fs.existsSync(asrPath) ? path.relative(path.dirname(scriptPath), asrPath).replace(/\\/g, "/") : null,
      durationMs: audio.durationMs,
      silenceSegments: audio.silenceSegments,
      entries: audio.entries,
      guidance:
        src.kind === "video"
          ? "Speech endMs is NOT the range out. Inspect frames at end/+500/+1000/+2000 and pick sourceEndMs where the screen result is complete."
          : "Audio source: prefer silence near sentence boundaries for range in/out.",
    };
    writeJson(path.join(sourceDir, `survey-${src.id}.json`), report);
    // compact index line for models
    index.push({
      id: src.id,
      kind: src.kind,
      durationMs: audio.durationMs,
      entryCount: entries.length,
      silenceCount: audio.silenceSegments.length,
      report: path.relative(outDir, path.join(sourceDir, `survey-${src.id}.json`)),
      contactSheet:
        src.kind === "video" && frameFiles.length
          ? path.relative(outDir, path.join(sourceDir, `contact-sheet-${src.id}-survey-original.png`))
          : null,
    });
    ctx.log(
      `  ${src.id} (${src.kind}): ${audio.durationMs}ms, ${entries.length} asr entries, ${audio.silenceSegments.length} silences` +
        (src.kind === "video" ? `, ${frameFiles.length} frames` : ""),
    );
  }

  writeJson(path.join(outDir, "summary.json"), {
    schemaVersion: 1,
    kind: "draft.survey",
    script: rel(ctx, scriptPath),
    clipsDir: rel(ctx, clipsDir),
    asrDir: rel(ctx, asrDir),
    sources: index,
    howToUse: [
      "1. Read summary.json then each survey-NN.json (and video contact sheets).",
      "2. Decide entry keep/cut from ASR text.",
      "3. For kind=video, set sourceEndMs using frames past speech end when UI still changing.",
      "4. Run uvid draft init to generate the draft.json skeleton, then edit decisions only.",
      "5. Run uvid draft check to apply-and-verify in one step.",
    ],
  });
  ctx.log(`uvid draft survey: wrote ${rel(ctx, outDir)} (${index.length} sources)`);
}

// --- draft init (skeleton generation) ---

export interface DraftInitParams {
  script: string;
  clipsDir: string;
  asrDir: string;
  /** Output draft.json path (episode dir determines relative paths inside). */
  output: string;
  /** Overwrite an existing draft.json. */
  force?: boolean;
}

/**
 * Generate the draft.json skeleton so the editor only writes decisions.
 * sources[] (path/asr/kind/durationMs) and entries[] (verbatim ASR) are machine
 * facts and are filled here; ranges[] stay empty — which sentences to keep and
 * where in/out land is the editor's judgment, not boilerplate.
 */
export async function draftInit(p: DraftInitParams, ctx: Ctx): Promise<void> {
  const scriptPath = resolveExisting(ctx, p.script, "--script");
  const clipsDir = resolveExisting(ctx, p.clipsDir, "--clips-dir");
  const asrDir = resolveExisting(ctx, p.asrDir, "--asr-dir");
  const outPath = resolvePath(ctx, p.output);
  if (fs.existsSync(outPath) && p.force !== true) {
    fail(`output already exists: ${rel(ctx, outPath)} (pass --force to overwrite)`);
  }
  const draftDir = path.dirname(outPath);

  const scriptSources = parseScriptSources(scriptPath);
  if (scriptSources.length === 0) fail("no media sources found in script");

  const clipFiles = fs.readdirSync(clipsDir);
  const sources: any[] = [];
  const entries: any[] = [];
  for (const src of scriptSources) {
    const clip = clipFiles.find((f) => f.startsWith(`${src.id}.`) && !f.startsWith("src-"));
    if (!clip) fail(`no clip for source ${src.id} in ${rel(ctx, clipsDir)} (run prep normalize first)`);
    const clipAbs = path.join(clipsDir, clip);
    const asrAbs = path.join(asrDir, `${src.id}.json`);
    const srcEntries = loadAsrEntries(asrAbs, src.id);
    if (!fs.existsSync(asrAbs)) {
      ctx.log(`  WARNING ${src.id}: missing ASR json ${rel(ctx, asrAbs)} — entries empty, run ASR first`);
    }
    sources.push({
      id: src.id,
      path: path.relative(draftDir, clipAbs),
      asr: path.relative(draftDir, asrAbs),
      kind: src.kind,
      durationMs: await mediaDurationMs(clipAbs, { signal: ctx.signal }),
      ranges: [],
      subtitles: [],
    });
    entries.push(...srcEntries);
  }

  writeJson(outPath, {
    $schema: path.relative(draftDir, draftSchemaPath()),
    schemaVersion: 1,
    episode: path.basename(draftDir),
    timebase: "source",
    sources,
    entries,
  });

  ctx.log(`uvid draft init: wrote ${rel(ctx, outPath)}`);
  for (const s of sources) {
    const n = entries.filter((e) => e.source === s.id).length;
    ctx.log(`  ${s.id} (${s.kind}): ${s.durationMs}ms, ${n} entries, ranges empty`);
  }
  ctx.log("  next: editor writes decisions (word cuts / ranges in-out / smoothing), then `uvid draft check`");
}
