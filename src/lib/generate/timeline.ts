/**
 * uvid generate timeline — edit.json → one timeline.json.
 *
 * Two products, same command:
 *   basis=aroll   — body only (no packaging, no dialog sequence)
 *   basis=program — intro/toc/outro media + dialog state sequence on program axis
 *
 * Single-stream: -i edit.json → -o timeline.json.
 * Does not scan cache/ or parse script.md.
 * Packaging is explicit media paths only (no default dir scan, no black placeholders):
 *   --intro / --outro = single rendered media files (duration probed)
 *   --toc-before ID,ID + --toc path,path = equal-length TOC media before those sources
 * BGM / dialog sprites are also explicit paths on the timeline (mixed/overlaid by generate video):
 *   --bgm path/to/bgm.mp3
 *   --dialog path/to/dialog-sprites/   (dir with idle/talk-closed/talk-open/wait-on.png)
 *
 * Compile rules (v0, frozen from 20260709 edit-v0 experiment):
 *   1. audio_kept = media − audio drops (keep overrides drop)
 *   2. discard audio shards < minAudioShardMs (default 120)
 *   3. video_kept = (audio_kept ∪ hold_until) − video drops
 *   4. hold extends picture only; audio follows audio drop/keep only
 *   5. collapse source-internal gaps on the program axis
 *   6. seam afade defaults; high-risk when collapsed source gap ≥ highRiskGapMs
 *   7. replace_text → captions on program axis (no cut)
 *   8. check → unresolved only
 *   9. program dialog[] from captions (word-timed mouth; box only while speaking);
 *      aroll non-turn gaps = idle (person only); packaging = hidden (no chrome)
 */
import fs from "node:fs";
import path from "node:path";
import { resolveInput, resolveOutput, writeJsonOutput } from "../io.ts";
import { hasAudioStream, hasVideoStream, mediaDurationMs } from "../proc.ts";
import { type Ctx, fail, rel, resolvePath } from "../util.ts";

import { DIALOG_NEEDLES, type DialogState } from "./sprite.ts";

/**
 * Fallback mouth half-period when a turn has no words (~10 Hz).
 * Prefer word-level open/closed halves from captions[].words.
 */
const DIALOG_TALK_MS = 100;
/** End-of-line wait arrow held inside the turn tail (not into silent gaps). */
/** Sentence-end ▼ window; ASS typewriter also finishes reveal before this tail. */
export const DIALOG_WAIT_TAIL_MS = 250;
/**
 * Inter-turn gap shorter than this = continuous speech: keep dialog box up
 * (talk-closed) so box never flashes mid-conversation.
 * Longer gaps (e.g. after ls -l demo / long mute) drop box with the text.
 */
const DIALOG_CONTINUOUS_GAP_MS = 1000;

export interface GenerateTimelineParams {
  input?: string;
  output?: string;
  /**
   * Intro media path (episode-relative or absolute). Required to insert intro.
   * Duration/audio probed from the file — no default path, no boolean placeholder.
   */
  intro?: string;
  /**
   * Outro media path (episode-relative or absolute). Required to insert outro.
   * Duration/audio probed from the file — no default path, no boolean placeholder.
   */
  outro?: string;
  /**
   * Source id(s) before which to insert TOC clips.
   * Must pair with --toc of equal length. Explicit positions — no script.md / dir scan.
   */
  tocBefore?: string | string[];
  /**
   * TOC media path(s), comma-separated or repeated. Equal length with --toc-before.
   * Duration/audio probed per file. Required when --toc-before is set.
   */
  toc?: string | string[];
  /** Optional titles; if set, length must match --toc-before. */
  tocTitles?: string | string[];
  /**
   * BGM audio path (episode-relative or absolute). Audio-only OK.
   * Bound into timeline.bgm; mixed under program audio by generate video.
   * Placement window is always intro-end → outro-start (body + TOC only).
   * Duration probed; loop/volume defaults live in policy + video mix.
   */
  bgm?: string;
  /**
   * Dialog sprite directory (episode-relative or absolute).
   * Must contain idle/talk-closed/talk-open/wait-on.png (from `generate render -f sprite`).
   * Bound into timeline.dialogSprites; overlaid by generate video when dialog[] non-empty.
   */
  dialog?: string;
  /** ASS revealed fill #RRGGBB for program burn-in. Stored on timeline.captionsStyle. */
  fg?: string;
  /** ASS panel reference #RRGGBB. Stored on timeline.captionsStyle. */
  bg?: string;
  /** ASS Fontname. Stored on timeline.captionsStyle. */
  font?: string;
  /** ASS Fontsize. Stored on timeline.captionsStyle. */
  fontSize?: number;
  /** Discard audio shards shorter than this; default 120. */
  minAudioShardMs?: number;
  /** Default edge afade ms; default 16. */
  fadeMs?: number;
  /** Collapsed source gap ≥ this → high-risk fade; default 1000. */
  highRiskGapMs?: number;
  /** High-risk edge afade ms; default 32. */
  highRiskFadeMs?: number;
  /** Range drop ending within this of media end snaps to end; default 500. */
  nearEndSnapMs?: number;
}

interface PackClip {
  mediaRel: string;
  durationMs: number;
  hasAudio: boolean;
}

interface BgmClip {
  mediaRel: string;
  durationMs: number;
}

/** BGM placement: after intro ends, before outro starts. TOC/body included. */
function bgmWindowMs(
  segments: Array<{ role: string; startMs: number; endMs: number }>,
  durationMs: number,
): { startMs: number; endMs: number } {
  const introEnd = Math.max(
    0,
    ...segments.filter((s) => s.role === "intro").map((s) => Math.trunc(s.endMs)),
  );
  const outroStarts = segments
    .filter((s) => s.role === "outro")
    .map((s) => Math.trunc(s.startMs));
  const outroStart = outroStarts.length ? Math.min(...outroStarts) : Math.trunc(durationMs);
  const startMs = Math.max(0, introEnd);
  const endMs = Math.max(startMs, outroStart);
  return { startMs, endMs };
}

interface DialogSprites {
  dirRel: string;
}

interface TocClip extends PackClip {
  beforeSourceId: string;
  title?: string;
}

interface DialogCue {
  startMs: number;
  endMs: number;
  state: DialogState;
  /** Optional turn this cue belongs to (talk / wait after that turn). */
  turnId?: string;
  sourceId?: string;
}

type Range = [number, number];

interface EditWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

interface EditTurn {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  words?: EditWord[];
}

interface EditActionWord {
  id?: string;
  text: string;
  startMs: number;
  endMs: number;
}

interface EditAction {
  id: string;
  op: "drop" | "keep" | "replace_text" | "hold_until" | "check";
  target: string | string[] | { startMs: number; endMs: number };
  track?: "audio" | "video" | "both";
  text?: string;
  /** Source-axis timings for turn-level replace_text (authored by edit skill). */
  words?: EditActionWord[];
  untilMs?: number;
  reason?: string;
  stage?: string;
  kind?: string;
}

interface EditSource {
  id: string;
  type: "audio" | "video";
  media: string;
  asr?: string;
  visual?: string;
  transcript: EditTurn[];
  actions: EditAction[];
}

interface EditDoc {
  kind?: string;
  version?: number;
  status?: string;
  title?: string;
  script?: string;
  sources: EditSource[];
}

interface SeamEdge {
  fadeMs: number;
  snapMs: number;
  risk: "low" | "high";
}

interface Segment {
  id: string;
  role: "aroll" | "intro" | "toc" | "outro";
  sourceId?: string;
  sourceType?: "audio" | "video";
  media?: string | null;
  visual?: string | null;
  inMs?: number;
  outMs?: number;
  startMs: number;
  endMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
  picture?: "still" | "media" | "none";
  kind?: "av" | "video_only" | "packaging";
  beforeSourceId?: string;
  title?: string;
  seam?: { in: SeamEdge; out: SeamEdge };
}

interface CaptionWord {
  id?: string;
  startMs: number;
  endMs: number;
  text: string;
}

interface Caption {
  startMs: number;
  endMs: number;
  text: string;
  sourceId?: string;
  turnId?: string;
  /** Program-axis words for RPG/typewriter reveal; preview SRT can ignore these. */
  words?: CaptionWord[];
}

function asList(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .map(([s, e]) => [Math.trunc(s), Math.trunc(e)] as Range)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!sorted.length) return [];
  const out: Range[] = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function subtractRanges(base: Range[], cuts: Range[]): Range[] {
  const cut = mergeRanges(cuts);
  const out: Range[] = [];
  for (const [s, e] of mergeRanges(base)) {
    let cur: Range[] = [[s, e]];
    for (const [cs, ce] of cut) {
      const next: Range[] = [];
      for (const [a, b] of cur) {
        if (ce <= a || cs >= b) {
          next.push([a, b]);
          continue;
        }
        if (cs > a) next.push([a, cs]);
        if (ce < b) next.push([ce, b]);
      }
      cur = next;
    }
    out.push(...cur);
  }
  return mergeRanges(out);
}

function invert(duration: number, drops: Range[]): Range[] {
  return subtractRanges([[0, duration]], drops);
}

function clampRange(s: number, e: number, dur: number): Range | null {
  const a = Math.max(0, Math.min(dur, Math.trunc(s)));
  const b = Math.max(0, Math.min(dur, Math.trunc(e)));
  return b > a ? [a, b] : null;
}

function unitMaps(src: EditSource): { turns: Map<string, EditTurn>; words: Map<string, EditWord> } {
  const turns = new Map<string, EditTurn>();
  const words = new Map<string, EditWord>();
  for (const t of src.transcript || []) {
    turns.set(t.id, t);
    for (const w of t.words || []) words.set(w.id, w);
  }
  return { turns, words };
}

function resolveTarget(
  src: EditSource,
  target: EditAction["target"],
  duration: number,
  nearEndSnapMs: number,
): Range[] {
  const { turns, words } = unitMaps(src);
  const one = (uid: string): Range[] => {
    if (turns.has(uid)) {
      const t = turns.get(uid)!;
      const r = clampRange(t.startMs, t.endMs, duration);
      return r ? [r] : [];
    }
    if (words.has(uid)) {
      const w = words.get(uid)!;
      const r = clampRange(w.startMs, w.endMs, duration);
      return r ? [r] : [];
    }
    fail(`unknown target id ${uid} in source ${src.id}`);
  };

  if (typeof target === "string") return one(target);
  if (Array.isArray(target)) {
    const out: Range[] = [];
    for (const uid of target) out.push(...one(String(uid)));
    return out;
  }
  if (target && typeof target === "object") {
    let s = Number(target.startMs);
    let e = Number(target.endMs);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      fail(`invalid range target in source ${src.id}`);
    }
    if (duration - e <= nearEndSnapMs) e = duration;
    const r = clampRange(s, e, duration);
    return r ? [r] : [];
  }
  fail(`invalid action target in source ${src.id}`);
}

function buildReplaceMap(src: EditSource): Map<string, string> {
  const { turns, words } = unitMaps(src);
  const m = new Map<string, string>();
  for (const t of src.transcript || []) m.set(t.id, t.text);
  const turnLevel = new Set<string>();
  for (const a of src.actions || []) {
    if (a.op !== "replace_text") continue;
    if (typeof a.target === "string" && turns.has(a.target) && a.text) {
      m.set(a.target, a.text);
      turnLevel.add(a.target);
    }
  }
  for (const a of src.actions || []) {
    if (a.op !== "replace_text" || !a.text) continue;
    if (typeof a.target === "string" && words.has(a.target)) {
      const turnId = a.target.replace(/-w\d+$/, "");
      if (turnLevel.has(turnId)) continue;
      const w = words.get(a.target)!;
      const old = m.get(turnId) ?? turns.get(turnId)?.text ?? "";
      m.set(turnId, old.replace(w.text, a.text));
    }
  }
  return m;
}

/**
 * Turn-level replace_text may carry authored source-axis words[].
 * Timeline trusts these and only projects them — no re-tokenize / re-slice.
 */
function buildReplaceWordsMap(src: EditSource): Map<string, EditActionWord[]> {
  const { turns } = unitMaps(src);
  const m = new Map<string, EditActionWord[]>();
  for (const a of src.actions || []) {
    if (a.op !== "replace_text") continue;
    if (typeof a.target !== "string" || !turns.has(a.target)) continue;
    if (!Array.isArray(a.words) || !a.words.length) continue;
    const cleaned: EditActionWord[] = [];
    for (const w of a.words) {
      const text = String(w?.text ?? "");
      const startMs = Math.trunc(Number(w?.startMs));
      const endMs = Math.trunc(Number(w?.endMs));
      if (!text || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      cleaned.push({
        ...(w.id ? { id: String(w.id) } : {}),
        text,
        startMs,
        endMs,
      });
    }
    if (cleaned.length) m.set(a.target, cleaned);
  }
  return m;
}

/** Collapse whitespace for surface comparison (CJK may have no spaces). */
function normalizeCaptionSurface(text: string): string {
  return String(text || "").replace(/\s+/g, "").trim();
}

function joinedWordText(words: CaptionWord[]): string {
  return normalizeCaptionSurface(words.map((w) => w.text).join(""));
}

/**
 * Split an edited turn into word-like tokens for karaoke + mouth timing.
 * Prefer whitespace tokens; otherwise group CJK/latin runs.
 */
function tokenizeCaptionText(text: string): string[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (/\s/.test(raw)) {
    return raw.split(/\s+/).filter(Boolean);
  }
  // No spaces: split into CJK chars / latin|digit runs / other single glyphs.
  const out: string[] = [];
  const re = /[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9./_+-]+|[^\s]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m[0]);
  return out.length ? out : [raw];
}

/**
 * Rebuild program-axis words from edited turn text, redistributing time over the
 * original word spans (or uniform over the turn if none). Keeps ASS karaoke and
 * dialog mouth on the same edited surface as caption text.
 */
function rebuildWordsFromTurnText(
  turnText: string,
  cueStart: number,
  cueEnd: number,
  oldWords: CaptionWord[],
): CaptionWord[] {
  const tokens = tokenizeCaptionText(turnText);
  if (!tokens.length) return [];
  const spanStart = oldWords.length ? oldWords[0].startMs : cueStart;
  const spanEnd = oldWords.length ? oldWords[oldWords.length - 1].endMs : cueEnd;
  const total = Math.max(1, spanEnd - spanStart);
  // Weight by character length so multi-glyph tokens get more time.
  const weights = tokens.map((t) => Math.max(1, [...t].length));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const out: CaptionWord[] = [];
  let cursor = spanStart;
  for (let i = 0; i < tokens.length; i++) {
    const share = i === tokens.length - 1 ? spanEnd - cursor : Math.max(1, Math.round((weights[i] / weightSum) * total));
    const end = i === tokens.length - 1 ? spanEnd : Math.min(spanEnd, cursor + share);
    if (end > cursor) {
      out.push({ startMs: cursor, endMs: end, text: tokens[i] });
      cursor = end;
    }
  }
  if (!out.length) out.push({ startMs: cueStart, endMs: Math.max(cueStart + 1, cueEnd), text: turnText });
  return out;
}

function relMedia(editDir: string, p: string | undefined | null): string | null {
  if (p == null || p === "" || p === "-") return null;
  // Keep paths relative to the edit/timeline directory (episode root),
  // so consumers can resolve against dirname(timeline.json).
  if (path.isAbsolute(p)) return path.relative(editDir, p) || path.basename(p);
  return p.replace(/\\/g, "/");
}

interface CompiledSource {
  segments: Segment[];
  captions: Caption[];
  unresolved: any[];
  durationMs: number;
}

async function compileSource(
  ctx: Ctx,
  src: EditSource,
  editDir: string,
  policy: Required<
    Pick<
      GenerateTimelineParams,
      "minAudioShardMs" | "fadeMs" | "highRiskGapMs" | "highRiskFadeMs" | "nearEndSnapMs"
    >
  >,
): Promise<CompiledSource> {
  if (!src?.id) fail("edit source missing id");
  if (src.type !== "audio" && src.type !== "video") fail(`source ${src.id}: type must be audio|video`);
  if (!src.media) fail(`source ${src.id}: media required`);
  if (!Array.isArray(src.transcript)) fail(`source ${src.id}: transcript required`);
  if (!Array.isArray(src.actions)) fail(`source ${src.id}: actions required`);

  const mediaAbs = path.resolve(editDir, src.media);
  const duration = await mediaDurationMs(mediaAbs, { signal: ctx.signal, cwd: ctx.cwd });

  const audioDrops: Range[] = [];
  const videoDrops: Range[] = [];
  const keeps: Range[] = [];
  const holds: Range[] = [];
  const unresolved: any[] = [];
  const replaceMap = buildReplaceMap(src);
  const replaceWordsMap = buildReplaceWordsMap(src);

  for (const a of src.actions) {
    const track = a.track ?? "audio";
    if (a.op === "check") {
      unresolved.push({
        sourceId: src.id,
        actionId: a.id,
        target: a.target,
        reason: a.reason,
        stage: a.stage,
        kind: a.kind,
      });
      continue;
    }
    if (a.op === "replace_text") continue;
    if (a.op === "hold_until") {
      const ranges = resolveTarget(src, a.target, duration, policy.nearEndSnapMs);
      if (!ranges.length) continue;
      const start = Math.min(...ranges.map(([s]) => s));
      const until = Math.min(duration, Math.trunc(Number(a.untilMs)));
      if (!Number.isFinite(until)) fail(`source ${src.id}: hold_until missing untilMs`);
      if (until > start) holds.push([start, until]);
      continue;
    }
    const ranges = resolveTarget(src, a.target, duration, policy.nearEndSnapMs);
    if (a.op === "drop") {
      if (track === "audio" || track === "both") audioDrops.push(...ranges);
      if (track === "video" || track === "both") videoDrops.push(...ranges);
    } else if (a.op === "keep") {
      keeps.push(...ranges);
    } else {
      fail(`source ${src.id}: unsupported op ${(a as any).op}`);
    }
  }

  const drops = keeps.length ? subtractRanges(mergeRanges(audioDrops), keeps) : mergeRanges(audioDrops);
  const audioKept = invert(duration, drops).filter(([s, e]) => e - s >= policy.minAudioShardMs);
  const videoKept = subtractRanges(mergeRanges([...audioKept, ...mergeRanges(holds)]), mergeRanges(videoDrops));
  const videoOnly = subtractRanges(videoKept, audioKept);

  type Piece = { kind: "av" | "video_only"; srcStart: number; srcEnd: number };
  const pieces: Piece[] = [
    ...audioKept.map(([s, e]) => ({ kind: "av" as const, srcStart: s, srcEnd: e })),
    ...videoOnly.map(([s, e]) => ({ kind: "video_only" as const, srcStart: s, srcEnd: e })),
  ].sort((a, b) => a.srcStart - b.srcStart || (a.kind === "av" ? 0 : 1) - (b.kind === "av" ? 0 : 1));

  const mediaRel = relMedia(editDir, src.media);
  const visualRel = relMedia(editDir, src.visual ?? null);
  const segments: Segment[] = [];
  let prog = 0;

  for (let idx = 0; idx < pieces.length; idx++) {
    const p = pieces[idx];
    const dur = p.srcEnd - p.srcStart;
    let seam: Segment["seam"];
    if (p.kind === "av") {
      let prevAv: Piece | undefined;
      for (let j = idx - 1; j >= 0; j--) if (pieces[j].kind === "av") { prevAv = pieces[j]; break; }
      let nextAv: Piece | undefined;
      for (let j = idx + 1; j < pieces.length; j++) if (pieces[j].kind === "av") { nextAv = pieces[j]; break; }
      let inFade = policy.fadeMs;
      let outFade = policy.fadeMs;
      let inRisk: "low" | "high" = "low";
      let outRisk: "low" | "high" = "low";
      if (prevAv && p.srcStart - prevAv.srcEnd >= policy.highRiskGapMs) {
        inRisk = "high";
        inFade = policy.highRiskFadeMs;
      }
      if (nextAv && nextAv.srcStart - p.srcEnd >= policy.highRiskGapMs) {
        outRisk = "high";
        outFade = policy.highRiskFadeMs;
      }
      seam = {
        in: { fadeMs: inFade, snapMs: 0, risk: inRisk },
        out: { fadeMs: outFade, snapMs: 0, risk: outRisk },
      };
    }
    segments.push({
      id: `seg-${src.id}-${String(idx).padStart(3, "0")}`,
      role: "aroll",
      sourceId: src.id,
      sourceType: src.type,
      media: mediaRel,
      visual: visualRel,
      inMs: p.srcStart,
      outMs: p.srcEnd,
      startMs: prog,
      endMs: prog + dur,
      hasAudio: p.kind === "av",
      hasVideo: true,
      picture: src.type === "audio" ? "still" : "media",
      kind: p.kind,
      ...(seam ? { seam } : {}),
    });
    prog += dur;
  }

  /** Map a source-axis time range onto program axis via audio segments. */
  const projectSourceRange = (ts: number, te: number): Range[] => {
    const spans: Range[] = [];
    for (const seg of segments) {
      if (!seg.hasAudio || seg.inMs == null || seg.outMs == null) continue;
      const a = Math.max(ts, seg.inMs);
      const b = Math.min(te, seg.outMs);
      if (b > a) spans.push([seg.startMs + (a - seg.inMs), seg.startMs + (b - seg.inMs)]);
    }
    return mergeRanges(spans);
  };

  const captions: Caption[] = [];
  for (const t of src.transcript || []) {
    const ts = Math.trunc(t.startMs);
    const te = Math.trunc(t.endMs);
    if (!audioKept.some(([a, b]) => Math.max(ts, a) < Math.min(te, b))) continue;
    const merged = projectSourceRange(ts, te);
    if (!merged.length) continue;

    // Word-level program times for RPG typewriter + mouth sync.
    // Priority:
    //   1) turn-level replace_text.words[] authored by edit skill (trust + project)
    //   2) ASR words + word-level replace_text surface edits
    //   3) fallback rebuild (re-tokenize + redistribute) only when surface changed
    //      without an authored axis
    const wordReplace = new Map<string, string>();
    for (const a of src.actions || []) {
      if (a.op !== "replace_text" || !a.text || typeof a.target !== "string") continue;
      if ((t.words || []).some((w) => w.id === a.target)) wordReplace.set(a.target, a.text);
    }
    const turnText = replaceMap.get(t.id) ?? t.text;
    const turnLevelReplace = replaceMap.has(t.id) && replaceMap.get(t.id) !== t.text;
    const authoredWords = replaceWordsMap.get(t.id);

    const projectWords = (
      srcWords: Array<{ id?: string; text: string; startMs: number; endMs: number }>,
      surfaceOf: (w: { id?: string; text: string }) => string,
    ): CaptionWord[] => {
      const out: CaptionWord[] = [];
      for (const w of srcWords) {
        const ws = Math.trunc(w.startMs);
        const we = Math.trunc(w.endMs);
        if (we <= ws) continue;
        // Keep words that still overlap any kept audio (partial keep ok).
        if (!audioKept.some(([a, b]) => Math.max(ws, a) < Math.min(we, b))) continue;
        const wMerged = projectSourceRange(ws, we);
        if (!wMerged.length) continue;
        out.push({
          ...(w.id ? { id: w.id } : {}),
          startMs: wMerged[0][0],
          endMs: wMerged[wMerged.length - 1][1],
          text: surfaceOf(w),
        });
      }
      return out;
    };

    const cueStart = merged[0][0];
    const cueEnd = merged[merged.length - 1][1];

    let finalWords: CaptionWord[] = [];
    if (authoredWords?.length) {
      // Skill-authored axis: project only. Do not rebuild/re-tokenize.
      finalWords = projectWords(authoredWords, (w) => w.text);
    } else {
      const words = projectWords(t.words || [], (w) =>
        w.id && wordReplace.has(w.id) ? wordReplace.get(w.id)! : w.text,
      );
      finalWords =
        turnLevelReplace || joinedWordText(words) !== normalizeCaptionSurface(turnText)
          ? rebuildWordsFromTurnText(turnText, cueStart, cueEnd, words)
          : words;
    }

    captions.push({
      startMs: cueStart,
      endMs: cueEnd,
      text: turnText,
      sourceId: src.id,
      turnId: t.id,
      ...(finalWords.length ? { words: finalWords } : {}),
    });
  }

  return { segments, captions, unresolved, durationMs: prog };
}

function shiftAll(segments: Segment[], captions: Caption[], delta: number): void {
  if (!delta) return;
  for (const s of segments) {
    s.startMs += delta;
    s.endMs += delta;
  }
  for (const c of captions) {
    c.startMs += delta;
    c.endMs += delta;
    if (c.words) {
      for (const w of c.words) {
        w.startMs += delta;
        w.endMs += delta;
      }
    }
  }
}

async function resolvePackClip(
  ctx: Ctx,
  editDir: string,
  rawPath: string | undefined,
  label: string,
): Promise<PackClip | null> {
  if (rawPath == null) return null;
  const trimmed = String(rawPath).trim();
  if (!trimmed) fail(`--${label} path is empty`);
  // Reject accidental boolean/true from old CLI habits.
  if (trimmed === "true" || trimmed === "false" || trimmed === "1" || trimmed === "0") {
    fail(`--${label} requires a media file path, not a boolean`);
  }
  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(editDir, trimmed);
  if (!fs.existsSync(abs)) fail(`--${label} file not found: ${trimmed}`);
  const durationMs = await mediaDurationMs(abs, { signal: ctx.signal, cwd: ctx.cwd });
  if (durationMs <= 0) fail(`--${label} has non-positive duration: ${trimmed}`);
  const hasVideo = await hasVideoStream(abs, { signal: ctx.signal, cwd: ctx.cwd });
  if (!hasVideo) fail(`--${label} has no video stream: ${trimmed}`);
  const hasAudio = await hasAudioStream(abs, { signal: ctx.signal, cwd: ctx.cwd });
  return {
    mediaRel: relMedia(editDir, abs) || path.basename(abs),
    durationMs,
    hasAudio,
  };
}

/** BGM is audio-only media bound onto the timeline (not a packaging video segment). */
async function resolveBgmClip(
  ctx: Ctx,
  editDir: string,
  rawPath: string | undefined,
): Promise<BgmClip | null> {
  if (rawPath == null) return null;
  const trimmed = String(rawPath).trim();
  if (!trimmed) fail("--bgm path is empty");
  if (trimmed === "true" || trimmed === "false" || trimmed === "1" || trimmed === "0") {
    fail("--bgm requires a media file path, not a boolean");
  }
  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(editDir, trimmed);
  if (!fs.existsSync(abs)) fail(`--bgm file not found: ${trimmed}`);
  const durationMs = await mediaDurationMs(abs, { signal: ctx.signal, cwd: ctx.cwd });
  if (durationMs <= 0) fail(`--bgm has non-positive duration: ${trimmed}`);
  const hasAudio = await hasAudioStream(abs, { signal: ctx.signal, cwd: ctx.cwd });
  if (!hasAudio) fail(`--bgm has no audio stream: ${trimmed}`);
  return {
    mediaRel: relMedia(editDir, abs) || path.basename(abs),
    durationMs,
  };
}

/** Dialog sprite dir bound onto the timeline (4 named PNGs; hidden may be absent). */
function resolveDialogSprites(editDir: string, rawPath: string | undefined): DialogSprites | null {
  if (rawPath == null) return null;
  const trimmed = String(rawPath).trim();
  if (!trimmed) fail("--dialog path is empty");
  if (trimmed === "true" || trimmed === "false" || trimmed === "1" || trimmed === "0") {
    fail("--dialog requires a sprite directory path, not a boolean");
  }
  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(editDir, trimmed);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    fail(`--dialog is not a directory: ${trimmed}`);
  }
  for (const name of DIALOG_NEEDLES) {
    const needle = path.join(abs, `${name}.png`);
    if (!fs.existsSync(needle)) fail(`--dialog missing ${name}.png: ${trimmed}`);
  }
  return {
    dirRel: relMedia(editDir, abs) || path.basename(abs),
  };
}

function pushDialogCue(
  out: DialogCue[],
  startMs: number,
  endMs: number,
  state: DialogState,
  meta?: { turnId?: string; sourceId?: string },
): void {
  const s = Math.trunc(startMs);
  const e = Math.trunc(endMs);
  if (e <= s) return;
  const last = out[out.length - 1];
  if (last && last.state === state && last.endMs === s && last.turnId === meta?.turnId && last.sourceId === meta?.sourceId) {
    last.endMs = e;
    return;
  }
  out.push({
    startMs: s,
    endMs: e,
    state,
    ...(meta?.turnId ? { turnId: meta.turnId } : {}),
    ...(meta?.sourceId ? { sourceId: meta.sourceId } : {}),
  });
}

function mergeSpans(spans: Array<{ startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number }> {
  const sorted = spans
    .map((s) => ({ startMs: Math.trunc(s.startMs), endMs: Math.trunc(s.endMs) }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (!sorted.length) return [];
  const out = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.startMs <= last.endMs) last.endMs = Math.max(last.endMs, cur.endMs);
    else out.push({ ...cur });
  }
  return out;
}

/** Clip [start,end) into aroll-only regions (packaging has no talk/wait). */
function clipToAroll(
  startMs: number,
  endMs: number,
  aroll: Array<{ startMs: number; endMs: number }>,
): Array<{ startMs: number; endMs: number }> {
  const out: Array<{ startMs: number; endMs: number }> = [];
  for (const span of aroll) {
    const s = Math.max(startMs, span.startMs);
    const e = Math.min(endMs, span.endMs);
    if (e > s) out.push({ startMs: s, endMs: e });
  }
  return out;
}

/**
 * Fill [start,end) with idle on aroll and hidden on packaging.
 * Packaging (intro/toc/outro) must not show person/box.
 */
function fillBaseDialog(
  out: DialogCue[],
  startMs: number,
  endMs: number,
  aroll: Array<{ startMs: number; endMs: number }>,
): void {
  if (endMs <= startMs) return;
  let cursor = startMs;
  for (const span of aroll) {
    if (span.endMs <= startMs) continue;
    if (span.startMs >= endMs) break;
    const a = Math.max(startMs, span.startMs);
    const b = Math.min(endMs, span.endMs);
    if (a > cursor) pushDialogCue(out, cursor, a, "hidden"); // packaging hole
    if (b > a) pushDialogCue(out, a, b, "idle");
    cursor = Math.max(cursor, b);
  }
  if (cursor < endMs) pushDialogCue(out, cursor, endMs, "hidden");
}

/**
 * Program-axis dialog chrome sequence from caption turns / words.
 *
 * Box follows continuous speech, not isolated words:
 * - whole turn window: box stays (talk-* / wait-on)
 * - short inter-turn gaps (< DIALOG_CONTINUOUS_GAP_MS): still box (talk-closed)
 *   → continuous language never flashes the panel off
 * - long silence (e.g. after ls -l demo): idle, person only, no box
 * - packaging: hidden
 *
 * Mouth still follows subtitle words (open/closed halves per word).
 */
function buildDialogSequence(
  captions: Caption[],
  arollSpans: Array<{ startMs: number; endMs: number }>,
  durationMs: number,
): DialogCue[] {
  const turns = captions
    .filter((c) => c.endMs > c.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const aroll = mergeSpans(arollSpans);
  if (durationMs <= 0) return [];

  // Paint talk/wait only inside aroll; packaging stays hidden via fillBaseDialog.
  const overlayRaw: DialogCue[] = [];
  const overlay = (
    startMs: number,
    endMs: number,
    state: DialogState,
    meta?: { turnId?: string; sourceId?: string },
  ) => {
    for (const piece of clipToAroll(startMs, endMs, aroll)) {
      pushDialogCue(overlayRaw, piece.startMs, piece.endMs, state, meta);
    }
  };

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const next = turns[i + 1];
    const meta = {
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      ...(turn.sourceId ? { sourceId: turn.sourceId } : {}),
    };

    const words = (turn.words || [])
      .filter((w) => w.endMs > w.startMs && String(w.text || "").length > 0)
      .slice()
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    // ▼ at sentence end. Prefer free tail after the last word so mouth/ASS
    // stay aligned through the full karaoke span; only steal from speech when
    // the last word runs to the cue end (still show a short wait-on).
    const lastWordEnd = words.length
      ? Math.min(turn.endMs, Math.max(turn.startMs, words[words.length - 1].endMs))
      : turn.endMs;
    let waitStart = Math.min(
      turn.endMs,
      Math.max(lastWordEnd, turn.endMs - DIALOG_WAIT_TAIL_MS),
    );
    if (waitStart >= turn.endMs) {
      waitStart = Math.max(turn.startMs, turn.endMs - DIALOG_WAIT_TAIL_MS);
    }
    // Mouth may run through the full turn when there is free wait tail; when we
    // had to steal, stop talk at waitStart so wait-on is not overwritten later.
    const talkEnd = waitStart;

    if (words.length) {
      // Cover caption body with box (not into the wait tail).
      // Mouth open only on the first half of each word; short intra-line pauses
      // keep talk-closed so the panel never drops mid-sentence.
      let cursor = turn.startMs;
      for (const w of words) {
        const ws = Math.max(turn.startMs, Math.min(talkEnd, w.startMs));
        const we = Math.max(ws, Math.min(talkEnd, w.endMs));
        if (we <= ws) continue;
        if (ws > cursor) overlay(cursor, ws, "talk-closed", meta);
        const mid = ws + Math.floor((we - ws) / 2);
        if (mid > ws) overlay(ws, mid, "talk-open", meta);
        if (we > mid) overlay(mid, we, "talk-closed", meta);
        cursor = Math.max(cursor, we);
      }
      if (cursor < talkEnd) overlay(cursor, talkEnd, "talk-closed", meta);
    } else if (talkEnd > turn.startMs) {
      // No words: fixed half-period across the talk body (box stays).
      let t = turn.startMs;
      let open = true;
      while (t < talkEnd) {
        const e = Math.min(talkEnd, t + DIALOG_TALK_MS);
        overlay(t, e, open ? "talk-open" : "talk-closed", meta);
        open = !open;
        t = e;
      }
    }

    // Always show ▼ when a line ends / next line is about to start.
    if (turn.endMs > waitStart) overlay(waitStart, turn.endMs, "wait-on", meta);

    // Bridge short inter-turn gaps: keep box + ▼ until the next sentence.
    // Long mute (e.g. after "还有 ls -l" demo) is left to idle via fillBaseDialog.
    if (next) {
      const gap = next.startMs - turn.endMs;
      if (gap > 0 && gap < DIALOG_CONTINUOUS_GAP_MS) {
        overlay(turn.endMs, next.startMs, "wait-on", meta);
      }
    }
  }

  // Flatten: base = idle(aroll) / hidden(packaging); then talk/wait overlays.
  if (!overlayRaw.length) {
    const baseOnly: DialogCue[] = [];
    fillBaseDialog(baseOnly, 0, durationMs, aroll);
    if (!baseOnly.length) pushDialogCue(baseOnly, 0, durationMs, aroll.length ? "idle" : "hidden");
    return baseOnly;
  }

  const events = overlayRaw.slice().sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: DialogCue[] = [];
  let cursor = 0;
  for (const cue of events) {
    if (cue.startMs > cursor) fillBaseDialog(merged, cursor, cue.startMs, aroll);
    // If cue starts before cursor (overlap), clamp.
    const s = Math.max(cursor, cue.startMs);
    if (cue.endMs > s) {
      pushDialogCue(merged, s, cue.endMs, cue.state, {
        ...(cue.turnId ? { turnId: cue.turnId } : {}),
        ...(cue.sourceId ? { sourceId: cue.sourceId } : {}),
      });
      cursor = Math.max(cursor, cue.endMs);
    }
  }
  if (cursor < durationMs) fillBaseDialog(merged, cursor, durationMs, aroll);
  if (!merged.length) fillBaseDialog(merged, 0, durationMs, aroll);
  // Defensive: never leave packaging as idle if aroll is empty at edges.
  if (!merged.length) pushDialogCue(merged, 0, durationMs, "hidden");
  return merged;
}

function insertPackaging(opts: {
  bodySegments: Segment[];
  bodyCaptions: Caption[];
  sourceOrder: string[];
  intro: PackClip | null;
  outro: PackClip | null;
  tocClips: TocClip[];
}): { segments: Segment[]; captions: Caption[]; durationMs: number } {
  const { bodySegments, bodyCaptions, sourceOrder, intro, outro, tocClips } = opts;

  // Group aroll segments by sourceId preserving order.
  const groups: { sourceId: string; segs: Segment[] }[] = [];
  for (const sid of sourceOrder) {
    groups.push({ sourceId: sid, segs: bodySegments.filter((s) => s.sourceId === sid) });
  }

  const tocBySource = new Map<string, TocClip>();
  for (const clip of tocClips) {
    if (tocBySource.has(clip.beforeSourceId)) {
      fail(`duplicate --toc-before source id: ${clip.beforeSourceId}`);
    }
    if (!sourceOrder.includes(clip.beforeSourceId)) {
      fail(`--toc-before unknown source id: ${clip.beforeSourceId}`);
    }
    tocBySource.set(clip.beforeSourceId, clip);
  }

  const out: Segment[] = [];
  let prog = 0;
  let packIdx = 0;

  const pushMediaPack = (role: "intro" | "outro" | "toc", clip: PackClip, extra?: Partial<Segment>) => {
    const dur = clip.durationMs;
    out.push({
      id: `seg-${role}-${String(packIdx++).padStart(3, "0")}`,
      role,
      startMs: prog,
      endMs: prog + dur,
      hasAudio: clip.hasAudio,
      hasVideo: true,
      picture: "media",
      kind: "packaging",
      media: clip.mediaRel,
      visual: null,
      inMs: 0,
      outMs: dur,
      title: role,
      ...extra,
    });
    prog += dur;
  };

  if (intro) pushMediaPack("intro", intro);

  // First compute body-local source bases from original body segments.
  const bodySourceBase = new Map<string, number>();
  for (const sid of sourceOrder) {
    const segs = bodySegments.filter((s) => s.sourceId === sid);
    if (segs.length) bodySourceBase.set(sid, Math.min(...segs.map((s) => s.startMs)));
    else bodySourceBase.set(sid, 0);
  }

  const captionShiftForSource = new Map<string, number>(); // newBase - oldBase

  for (const g of groups) {
    const toc = tocBySource.get(g.sourceId);
    if (toc) {
      pushMediaPack("toc", toc, {
        beforeSourceId: toc.beforeSourceId,
        ...(toc.title != null ? { title: toc.title } : { title: "toc" }),
      });
    }
    if (!g.segs.length) continue;
    const oldBase = bodySourceBase.get(g.sourceId) ?? 0;
    const newBase = prog;
    captionShiftForSource.set(g.sourceId, newBase - oldBase);
    for (const seg of g.segs) {
      const dur = seg.endMs - seg.startMs;
      out.push({
        ...seg,
        startMs: prog,
        endMs: prog + dur,
      });
      prog += dur;
    }
  }

  if (outro) pushMediaPack("outro", outro);

  const captions = bodyCaptions.map((c) => {
    const shift = c.sourceId ? captionShiftForSource.get(c.sourceId) ?? 0 : 0;
    return {
      ...c,
      startMs: c.startMs + shift,
      endMs: c.endMs + shift,
      // RPG typewriter words must stay on the same program axis as the turn cue.
      ...(c.words?.length
        ? {
            words: c.words.map((w) => ({
              ...w,
              startMs: w.startMs + shift,
              endMs: w.endMs + shift,
            })),
          }
        : {}),
    };
  });

  return { segments: out, captions, durationMs: prog };
}

export async function generateTimeline(p: GenerateTimelineParams, ctx: Ctx): Promise<void> {
  const input = resolveInput(ctx, p.input, "edit.json");
  const output = resolveOutput(ctx, p.output);
  const raw = await (async () => {
    const { readInputJson } = await import("../io.ts");
    return readInputJson(ctx, input);
  })();

  if (!raw || typeof raw !== "object") fail("edit.json must be an object");
  const edit = raw as EditDoc;
  if (!Array.isArray(edit.sources) || edit.sources.length === 0) fail("edit.json sources[] required");

  const editAbs = input.path ?? resolvePath(ctx, "edit.json");
  const editDir = path.dirname(editAbs);

  const policy = {
    minAudioShardMs: p.minAudioShardMs ?? 120,
    fadeMs: p.fadeMs ?? 16,
    highRiskGapMs: p.highRiskGapMs ?? 1000,
    highRiskFadeMs: p.highRiskFadeMs ?? 32,
    nearEndSnapMs: p.nearEndSnapMs ?? 500,
  };
  if (policy.minAudioShardMs < 0) fail("--min-audio-shard-ms must be >= 0");
  if (policy.fadeMs < 0 || policy.highRiskFadeMs < 0) fail("fade ms must be >= 0");

  const tocBefore = asList(p.tocBefore);
  const tocPaths = asList(p.toc);
  const tocTitles = asList(p.tocTitles);

  if (tocBefore.length && !tocPaths.length) {
    fail("--toc-before requires equal-length --toc path,path (no black placeholders)");
  }
  if (tocPaths.length && !tocBefore.length) {
    fail("--toc requires --toc-before of equal length");
  }
  if (tocBefore.length !== tocPaths.length) {
    fail(`--toc length (${tocPaths.length}) must match --toc-before (${tocBefore.length})`);
  }
  if (tocTitles.length && tocTitles.length !== tocBefore.length) {
    fail(`--toc-titles length (${tocTitles.length}) must match --toc-before (${tocBefore.length})`);
  }

  const introClip = await resolvePackClip(ctx, editDir, p.intro, "intro");
  const outroClip = await resolvePackClip(ctx, editDir, p.outro, "outro");
  const bgmClip = await resolveBgmClip(ctx, editDir, p.bgm);
  const dialogSprites = resolveDialogSprites(editDir, p.dialog);

  const tocClips: TocClip[] = [];
  for (let i = 0; i < tocBefore.length; i++) {
    const clip = await resolvePackClip(ctx, editDir, tocPaths[i], `toc[${i}]`);
    if (!clip) fail(`--toc[${i}] unresolved: ${tocPaths[i]}`);
    tocClips.push({
      ...clip,
      beforeSourceId: tocBefore[i],
      ...(tocTitles[i] != null ? { title: tocTitles[i] } : {}),
    });
  }

  const bodySegments: Segment[] = [];
  const bodyCaptions: Caption[] = [];
  const unresolved: any[] = [];
  const sourceOrder: string[] = [];
  const sourceSummaries: any[] = [];
  let bodyProg = 0;

  for (const src of edit.sources) {
    sourceOrder.push(src.id);
    const compiled = await compileSource(ctx, src, editDir, policy);
    shiftAll(compiled.segments, compiled.captions, bodyProg);
    bodySegments.push(...compiled.segments);
    bodyCaptions.push(...compiled.captions);
    unresolved.push(...compiled.unresolved);
    sourceSummaries.push({
      id: src.id,
      type: src.type,
      programStartMs: bodyProg,
      programEndMs: bodyProg + compiled.durationMs,
      segments: compiled.segments.length,
      captions: compiled.captions.length,
    });
    bodyProg += compiled.durationMs;
  }

  // program = any packaging media; dialog sequence only on program timelines.
  const hasPackaging = Boolean(introClip || outroClip || tocClips.length > 0);
  let segments = bodySegments;
  let captions = bodyCaptions;
  let durationMs = bodyProg;

  if (hasPackaging) {
    const packed = insertPackaging({
      bodySegments,
      bodyCaptions,
      sourceOrder,
      intro: introClip,
      outro: outroClip,
      tocClips,
    });
    segments = packed.segments;
    captions = packed.captions;
    durationMs = packed.durationMs;
    // refresh source summaries against packed aroll segments
    for (const sum of sourceSummaries) {
      const segs = segments.filter((s) => s.role === "aroll" && s.sourceId === sum.id);
      if (!segs.length) {
        sum.programStartMs = 0;
        sum.programEndMs = 0;
        sum.segments = 0;
        continue;
      }
      sum.programStartMs = Math.min(...segs.map((s) => s.startMs));
      sum.programEndMs = Math.max(...segs.map((s) => s.endMs));
      sum.segments = segs.length;
      sum.captions = captions.filter((c) => c.sourceId === sum.id).length;
    }
  }

  const basis = hasPackaging ? "program" : "aroll";
  const arollSpans = segments
    .filter((s) => s.role === "aroll")
    .map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
  // Dialog sequence is a program-timeline product (compose chrome over A-roll turns).
  const dialog = basis === "program" ? buildDialogSequence(captions, arollSpans, durationMs) : [];

  const timeline = {
    kind: "uvid.timeline",
    version: 0,
    basis,
    from: {
      edit: input.path ? rel(ctx, input.path) : "stdin",
      ...(edit.status ? { status: edit.status } : {}),
      ...(edit.title ? { title: edit.title } : {}),
      ...(edit.script ? { script: edit.script } : {}),
    },
    packaging: {
      intro: introClip?.mediaRel ?? null,
      outro: outroClip?.mediaRel ?? null,
      tocBefore,
      toc: tocClips.map((c) => c.mediaRel),
      ...(tocTitles.length ? { tocTitles } : {}),
    },
    // Assets bound at compile time — generate video reads only timeline.json.
    // BGM window = intro end → outro start (body + TOC; never under intro/outro).
    bgm: bgmClip
      ? (() => {
          const win = bgmWindowMs(segments, durationMs);
          return {
            media: bgmClip.mediaRel,
            durationMs: bgmClip.durationMs,
            startMs: win.startMs,
            endMs: win.endMs,
            // loop to cover the BGM window when bed is shorter
            loop: true,
            // bed under dialog; default bed level
            volume: 0.22,
          };
        })()
      : null,
    dialogSprites: dialogSprites
      ? {
          dir: dialogSprites.dirRel,
          needles: [...DIALOG_NEEDLES],
        }
      : null,
    captionsStyle: {
      burn: true,
      style: "typewriter",
      fg: p.fg || "#d3c6aa",
      bg: p.bg || "#272e33",
      font: p.font || "Fusion Pixel 12px M zh_hans",
      ...(p.fontSize != null && Number.isFinite(p.fontSize) ? { fontSize: Math.round(p.fontSize) } : {}),
    },
    policy: {
      minAudioShardMs: policy.minAudioShardMs,
      fadeMs: policy.fadeMs,
      highRiskGapMs: policy.highRiskGapMs,
      highRiskFadeMs: policy.highRiskFadeMs,
      nearEndSnapMs: policy.nearEndSnapMs,
      crossfade: "never",
      collapseSourceGaps: true,
      holdMeans: "extend_picture_only; audio follows audio drop/keep only",
      dialogTalkMs: DIALOG_TALK_MS,
      dialogWaitTailMs: DIALOG_WAIT_TAIL_MS,
      dialogContinuousGapMs: DIALOG_CONTINUOUS_GAP_MS,
      dialogMouth: "word-timed",
      ...(introClip ? { introMs: introClip.durationMs } : {}),
      ...(outroClip ? { outroMs: outroClip.durationMs } : {}),
      ...(tocClips.length
        ? { tocMs: tocClips.map((c) => c.durationMs) }
        : {}),
      ...(bgmClip
        ? (() => {
            const win = bgmWindowMs(segments, durationMs);
            return {
              bgmMs: bgmClip.durationMs,
              bgmStartMs: win.startMs,
              bgmEndMs: win.endMs,
              bgmVolume: 0.22,
              bgmLoop: true,
            };
          })()
        : {}),
    },
    durationMs,
    unresolved,
    sources: sourceSummaries,
    segments,
    captions,
    dialog,
  };

  writeJsonOutput(ctx, output, timeline);
  ctx.log(
    `timeline basis=${timeline.basis} durationMs=${durationMs} segments=${segments.length} captions=${captions.length} dialog=${dialog.length} unresolved=${unresolved.length}` +
      (introClip ? ` intro=${introClip.mediaRel}` : "") +
      (outroClip ? ` outro=${outroClip.mediaRel}` : "") +
      (tocBefore.length ? ` tocBefore=${tocBefore.join(",")}` : "") +
      (tocClips.length ? ` toc=${tocClips.map((c) => c.mediaRel).join(",")}` : "") +
      (bgmClip ? ` bgm=${bgmClip.mediaRel}` : "") +
      (dialogSprites ? ` dialog=${dialogSprites.dirRel}` : ""),
  );
}
