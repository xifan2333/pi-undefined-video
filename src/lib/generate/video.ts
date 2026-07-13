/**
 * uvid generate video — timeline.json → one episode mp4 (audio+video).
 *
 * Single-stream: -i timeline.json -o out.mp4.
 * Reads ALL product assets from the timeline (packaging segments, dialog[],
 * dialogSprites, bgm, captionsStyle). No side asset flags on this command.
 * Only render presets remain: quality / fps / width / height.
 *
 * basis=aroll  → body A-roll only.
 * basis=program + dialog[] + dialogSprites → base + needle overlay + ASS burn-in.
 * timeline.bgm → mixed under program audio.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInput, resolveOutput, publishFileOutput } from "../io.ts";
import { ffmpeg } from "../proc.ts";
import { type Ctx, ensureDir, fail, rel, resolvePath } from "../util.ts";
import { buildAssFromCaptions } from "./captions.ts";
import { DIALOG_NEEDLES, DIALOG_STATES } from "./timeline.ts";

export interface GenerateVideoParams {
  input?: string;
  output?: string;
  /** draft | standard | high. Default draft for review. */
  quality?: string;
  fps?: number;
  width?: number;
  height?: number;
}

interface SeamEdge {
  fadeMs?: number;
  snapMs?: number;
  risk?: string;
}

interface TimelineSegment {
  id: string;
  role: string;
  sourceId?: string;
  sourceType?: string;
  media?: string | null;
  visual?: string | null;
  inMs?: number;
  outMs?: number;
  startMs: number;
  endMs: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  picture?: "still" | "media" | "none" | string;
  kind?: string;
  seam?: { in?: SeamEdge; out?: SeamEdge };
}

interface DialogCue {
  startMs: number;
  endMs: number;
  state: string;
  turnId?: string;
  sourceId?: string;
}

interface CaptionWord {
  startMs: number;
  endMs: number;
  text: string;
}

interface Caption {
  startMs: number;
  endMs: number;
  text: string;
  words?: CaptionWord[];
}

interface TimelineBgm {
  media: string;
  durationMs?: number;
  /** Program-axis window start (intro end). Default 0 for legacy timelines. */
  startMs?: number;
  /** Program-axis window end (outro start). Default full duration for legacy. */
  endMs?: number;
  loop?: boolean;
  volume?: number;
}

interface TimelineDialogSprites {
  dir: string;
  needles?: string[];
}

interface TimelineCaptionsStyle {
  burn?: boolean;
  style?: string;
  fg?: string;
  bg?: string;
  font?: string;
  fontSize?: number;
}

interface TimelineDoc {
  kind?: string;
  basis?: string;
  durationMs?: number;
  segments?: TimelineSegment[];
  dialog?: DialogCue[];
  captions?: Caption[];
  bgm?: TimelineBgm | null;
  dialogSprites?: TimelineDialogSprites | null;
  captionsStyle?: TimelineCaptionsStyle | null;
}

type DialogState = (typeof DIALOG_STATES)[number];

function qualityToCrf(q: string): { crf: number; preset: string; audioKbps: string } {
  switch (q) {
    case "high":
      return { crf: 18, preset: "medium", audioKbps: "192k" };
    case "standard":
      return { crf: 23, preset: "fast", audioKbps: "160k" };
    case "draft":
    default:
      return { crf: 28, preset: "veryfast", audioKbps: "160k" };
  }
}

function vf(width: number, height: number, fps: number): string {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
    "setsar=1",
    "format=yuv420p",
  ].join(",");
}

async function runFfmpeg(args: string[], ctx: Ctx): Promise<void> {
  await ffmpeg(args, { signal: ctx.signal, cwd: ctx.cwd });
}

function isDialogState(s: string): s is DialogState {
  return (DIALOG_STATES as readonly string[]).includes(s);
}

function mergeDialogCues(cues: DialogCue[]): DialogCue[] {
  const out: DialogCue[] = [];
  for (const c of cues) {
    const startMs = Math.trunc(c.startMs);
    const endMs = Math.trunc(c.endMs);
    if (endMs <= startMs) continue;
    if (!isDialogState(c.state)) fail(`dialog cue has unknown state: ${c.state}`);
    const last = out[out.length - 1];
    if (last && last.state === c.state && last.endMs === startMs) {
      last.endMs = endMs;
      continue;
    }
    out.push({ startMs, endMs, state: c.state });
  }
  return out;
}

async function ensureHiddenPng(
  dialogDir: string,
  width: number,
  height: number,
  ctx: Ctx,
): Promise<string> {
  const hidden = path.join(dialogDir, "hidden.png");
  if (fs.existsSync(hidden)) return hidden;
  // Fully transparent RGBA — packaging windows show no person/box.
  await runFfmpeg(
    [
      "-f",
      "lavfi",
      "-i",
      `color=c=black@0.0:s=${width}x${height}:d=1,format=rgba`,
      "-frames:v",
      "1",
      hidden,
    ],
    ctx,
  );
  return hidden;
}

function requireDialogNeedles(dialogDir: string): void {
  for (const name of DIALOG_NEEDLES) {
    const p = path.join(dialogDir, `${name}.png`);
    if (!fs.existsSync(p)) fail(`dialog needle missing: ${p}`);
  }
}

/**
 * Build a qtrle ARGB overlay mov from dialog[] + named PNGs, then
 * overlay onto base + optional ASS burn-in.
 */
/**
 * Mix timeline.bgm under program audio inside [startMs, endMs).
 * Outside that window only program audio is heard (intro/outro keep their own beds).
 */
async function mixBgmUnderProgram(opts: {
  baseMp4: string;
  outMp4: string;
  bgmAbs: string;
  /** Full program duration (output length). */
  durationMs: number;
  /** BGM window on program axis. */
  startMs: number;
  endMs: number;
  loop: boolean;
  volume: number;
  quality: { crf: number; preset: string; audioKbps: string };
  ctx: Ctx;
}): Promise<void> {
  const { baseMp4, outMp4, bgmAbs, durationMs, startMs, endMs, loop, volume, quality: q, ctx } =
    opts;
  const programS = Math.max(0, durationMs) / 1000;
  const winStart = Math.max(0, Math.min(durationMs, Math.trunc(startMs)));
  const winEnd = Math.max(winStart, Math.min(durationMs, Math.trunc(endMs)));
  const winMs = winEnd - winStart;
  const vol = Math.max(0, Math.min(1, volume));

  // No active window → pass-through copy.
  if (winMs <= 0 || vol <= 0) {
    fs.copyFileSync(baseMp4, outMp4);
    return;
  }

  const winStartS = (winStart / 1000).toFixed(3);
  const winMsS = (winMs / 1000).toFixed(3);
  const programSStr = programS.toFixed(3);

  // Stream 0 = program A/V; stream 1 = BGM bed (optionally looped), then delayed to startMs.
  const args: string[] = ["-i", baseMp4];
  if (loop) args.push("-stream_loop", "-1");
  // Read only the bed length we need for the window (loop handles short beds).
  args.push("-i", bgmAbs, "-t", programSStr);
  args.push(
    "-filter_complex",
    // Program audio full length.
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];` +
      // BGM: format → volume → trim to window length → delay to startMs → pad to program length.
      `[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol.toFixed(4)},` +
      `atrim=0:${winMsS},asetpts=PTS-STARTPTS,` +
      `adelay=${winStart}|${winStart},apad=whole_dur=${programSStr}[a1];` +
      // Mix; duration=first keeps program length.
      `[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
    "-map",
    "0:v:0",
    "-map",
    "[a]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    q.audioKbps,
    "-shortest",
    "-movflags",
    "+faststart",
    outMp4,
  );
  // adelay takes ms; silence before start is intentional (intro).
  void winStartS;
  await runFfmpeg(args, ctx);
}

async function composeProgramLayers(opts: {
  baseMp4: string;
  outMp4: string;
  dialogDir: string;
  dialog: DialogCue[];
  durationMs: number;
  fps: number;
  width: number;
  height: number;
  burnCaptions: boolean;
  captions: Caption[];
  look: { fg?: string; bg?: string; font?: string; fontSize?: number };
  quality: { crf: number; preset: string; audioKbps: string };
  tmpRoot: string;
  ctx: Ctx;
}): Promise<void> {
  const {
    baseMp4,
    outMp4,
    dialogDir,
    dialog,
    durationMs,
    fps,
    width,
    height,
    burnCaptions,
    captions,
    look,
    quality: q,
    tmpRoot,
    ctx,
  } = opts;

  requireDialogNeedles(dialogDir);
  await ensureHiddenPng(dialogDir, width, height, ctx);

  const merged = mergeDialogCues(dialog);
  if (!merged.length) fail("program dialog[] is empty after merge");

  // Cover full program duration so overlay stream never ends early.
  if (merged[0].startMs > 0) {
    merged.unshift({ startMs: 0, endMs: merged[0].startMs, state: "hidden" });
  }
  const last = merged[merged.length - 1];
  if (last.endMs < durationMs) {
    merged.push({ startMs: last.endMs, endMs: durationMs, state: "hidden" });
  }

  // Frame-quantized durations on the program axis.
  // Per-cue wall-clock seconds accumulate rounding error vs ASS absolute times
  // (many short mouth cues → dialog drifts later than typewriter). Snap each
  // cue end to an absolute frame, then duration = endFrame - prevEndFrame.
  const totalFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
  const msToFrame = (ms: number) =>
    Math.max(0, Math.min(totalFrames, Math.round((Math.max(0, ms) / 1000) * fps)));

  const concatList = path.join(tmpRoot, "dialog.concat.txt");
  const lines: string[] = [];
  let prevFrame = 0;
  let written = 0;
  for (let i = 0; i < merged.length; i++) {
    const c = merged[i];
    const endFrame = i === merged.length - 1 ? totalFrames : msToFrame(c.endMs);
    const frames = Math.max(0, endFrame - prevFrame);
    if (frames <= 0) continue;
    const dur = frames / fps;
    const file = path.join(dialogDir, `${c.state}.png`).replace(/'/g, "'\\''");
    lines.push(`file '${file}'`);
    lines.push(`duration ${dur.toFixed(6)}`);
    prevFrame = endFrame;
    written += 1;
  }
  if (!written) fail("dialog overlay produced no concat entries");
  // concat demuxer needs trailing file entry after last duration
  const tailState = merged[merged.length - 1].state;
  lines.push(`file '${path.join(dialogDir, `${tailState}.png`).replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(concatList, lines.join("\n") + "\n");

  const overlayPath = path.join(tmpRoot, "dialog-overlay.mov");
  // Exact frame count — avoid -t seconds re-rounding against ASS timeline.
  const framesExpr = String(totalFrames);
  await runFfmpeg(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatList,
      "-r",
      String(fps),
      "-frames:v",
      framesExpr,
      "-c:v",
      "qtrle",
      "-pix_fmt",
      "argb",
      "-an",
      overlayPath,
    ],
    ctx,
  );

  let assPath: string | null = null;
  if (burnCaptions && captions.length) {
    assPath = path.join(tmpRoot, "program-typewriter.ass");
    const ass = buildAssFromCaptions(captions, "typewriter", look);
    fs.writeFileSync(assPath, ass, "utf8");
  }

  // Escape for ffmpeg ass= filter (path may contain : on some systems).
  const escapeAssPath = (p: string) =>
    p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

  const filterComplex = assPath
    ? `[0:v][1:v]overlay=0:0:format=auto,ass='${escapeAssPath(assPath)}'[v]`
    : `[0:v][1:v]overlay=0:0:format=auto[v]`;

  await runFfmpeg(
    [
      "-i",
      baseMp4,
      "-i",
      overlayPath,
      "-filter_complex",
      filterComplex,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      q.preset,
      "-crf",
      String(q.crf),
      "-pix_fmt",
      "yuv420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      "-c:a",
      "aac",
      "-b:a",
      q.audioKbps,
      "-shortest",
      "-movflags",
      "+faststart",
      outMp4,
    ],
    ctx,
  );
}

export async function generateVideo(p: GenerateVideoParams, ctx: Ctx): Promise<void> {
  const input = resolveInput(ctx, p.input, "timeline.json");
  if (!p.output) fail("generate video requires -o FILE.mp4 (binary product)");
  const output = resolveOutput(ctx, p.output, { binary: true });
  if (!output.path) fail("generate video requires -o FILE.mp4");

  const { readInputJson } = await import("../io.ts");
  const raw = await readInputJson(ctx, input);
  if (!raw || typeof raw !== "object") fail("timeline.json must be an object");
  const tl = raw as TimelineDoc;
  if (tl.kind && tl.kind !== "uvid.timeline") fail(`expected kind uvid.timeline, got ${tl.kind}`);
  const segments = tl.segments;
  if (!Array.isArray(segments) || segments.length === 0) fail("timeline.segments[] required");

  const fps = p.fps ?? 25;
  const width = p.width ?? 1280;
  const height = p.height ?? 720;
  if (fps <= 0) fail("--fps must be > 0");
  if (width <= 0 || height <= 0) fail("--width/--height must be > 0");

  const quality = (p.quality || "draft").toLowerCase();
  if (!["draft", "standard", "high"].includes(quality)) {
    fail(`--quality must be draft|standard|high, got ${p.quality}`);
  }
  const q = qualityToCrf(quality);
  const filter = vf(width, height, fps);

  const timelineAbs = input.path ?? resolvePath(ctx, "timeline.json");
  const baseDir = path.dirname(timelineAbs);
  const basis = (tl.basis || "aroll").toLowerCase();
  const dialogCues = Array.isArray(tl.dialog) ? tl.dialog : [];
  const captions = Array.isArray(tl.captions) ? tl.captions : [];
  const durationMs =
    tl.durationMs != null && Number.isFinite(tl.durationMs)
      ? Math.trunc(tl.durationMs)
      : Math.max(0, ...segments.map((s) => Math.trunc(s.endMs || 0)));

  // All product assets come from the timeline — video has no side path flags.
  const wantsDialog = basis === "program" && dialogCues.length > 0;
  const style = tl.captionsStyle && typeof tl.captionsStyle === "object" ? tl.captionsStyle : null;
  const burnCaptions =
    basis === "program" && captions.length > 0 && style?.burn !== false;
  const look = {
    fg: style?.fg,
    bg: style?.bg,
    font: style?.font,
    fontSize: style?.fontSize,
  };

  let dialogDir: string | null = null;
  if (wantsDialog) {
    const sprites = tl.dialogSprites && typeof tl.dialogSprites === "object" ? tl.dialogSprites : null;
    if (!sprites?.dir) {
      fail(
        "generate video: basis=program with dialog[] requires timeline.dialogSprites.dir " +
          "(bind via `generate timeline --dialog DIR`)",
      );
    }
    dialogDir = path.isAbsolute(sprites.dir) ? sprites.dir : path.resolve(baseDir, sprites.dir);
    if (!fs.existsSync(dialogDir) || !fs.statSync(dialogDir).isDirectory()) {
      fail(`timeline.dialogSprites.dir not found: ${sprites.dir}`);
    }
  }

  const tlBgm = tl.bgm && typeof tl.bgm === "object" ? tl.bgm : null;
  let bgmAbs: string | null = null;
  let bgmLoop = true;
  let bgmVolume = 0.22;
  // Window defaults: full program (legacy). Timeline compile writes intro-end → outro-start.
  let bgmStartMs = 0;
  let bgmEndMs = durationMs;
  if (tlBgm?.media) {
    bgmAbs = path.isAbsolute(tlBgm.media) ? tlBgm.media : path.resolve(baseDir, tlBgm.media);
    if (!fs.existsSync(bgmAbs)) fail(`timeline.bgm.media not found: ${tlBgm.media}`);
    bgmLoop = tlBgm.loop !== false;
    bgmVolume =
      tlBgm.volume != null && Number.isFinite(tlBgm.volume) ? Number(tlBgm.volume) : 0.22;
    if (bgmVolume < 0 || bgmVolume > 1) fail(`timeline.bgm.volume must be 0..1, got ${bgmVolume}`);
    if (tlBgm.startMs != null && Number.isFinite(tlBgm.startMs)) bgmStartMs = Math.trunc(tlBgm.startMs);
    if (tlBgm.endMs != null && Number.isFinite(tlBgm.endMs)) bgmEndMs = Math.trunc(tlBgm.endMs);
    if (bgmEndMs < bgmStartMs) fail(`timeline.bgm.endMs (${bgmEndMs}) < startMs (${bgmStartMs})`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uvid-video-"));
  const chunks: string[] = [];

  try {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const durMs = Math.max(0, Math.trunc(seg.endMs) - Math.trunc(seg.startMs));
      if (durMs <= 0) fail(`segment ${seg.id || i}: non-positive duration`);
      const durS = durMs / 1000;
      const inMs = seg.inMs != null ? Math.trunc(seg.inMs) : 0;
      const ss = inMs / 1000;
      const vpath = path.join(tmpRoot, `v${String(i).padStart(3, "0")}.mp4`);
      const apath = path.join(tmpRoot, `a${String(i).padStart(3, "0")}.wav`);
      const mpath = path.join(tmpRoot, `m${String(i).padStart(3, "0")}.mp4`);

      const picture =
        seg.picture || (seg.role === "aroll" ? (seg.sourceType === "audio" ? "still" : "media") : "none");
      const media = seg.media ? path.resolve(baseDir, seg.media) : null;
      const visual = seg.visual ? path.resolve(baseDir, seg.visual) : null;

      // ---- video plane ----
      if (picture === "still") {
        if (!visual || !fs.existsSync(visual)) {
          fail(`segment ${seg.id}: audio/still needs visual file (got ${seg.visual || "none"})`);
        }
        await runFfmpeg(
          [
            "-loop",
            "1",
            "-i",
            visual,
            "-t",
            durS.toFixed(3),
            "-vf",
            filter,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_range",
            "tv",
            vpath,
          ],
          ctx,
        );
      } else if (picture === "media") {
        if (!media || !fs.existsSync(media)) {
          fail(`segment ${seg.id}: media file missing: ${seg.media}`);
        }
        await runFfmpeg(
          [
            "-ss",
            ss.toFixed(3),
            "-i",
            media,
            "-t",
            durS.toFixed(3),
            "-vf",
            filter,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_range",
            "tv",
            vpath,
          ],
          ctx,
        );
      } else {
        // packaging / none → black
        await runFfmpeg(
          [
            "-f",
            "lavfi",
            "-i",
            `color=c=black:s=${width}x${height}:r=${fps}`,
            "-t",
            durS.toFixed(3),
            "-vf",
            filter,
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-color_range",
            "tv",
            vpath,
          ],
          ctx,
        );
      }

      // ---- audio plane ----
      // Critical: still/markdown segments still take audio from media (normalized.mp3), not silence.
      if (seg.hasAudio) {
        if (!media || !fs.existsSync(media)) {
          fail(`segment ${seg.id}: hasAudio but media missing: ${seg.media}`);
        }
        const fadeIn = Math.max(0, Number(seg.seam?.in?.fadeMs ?? 16)) / 1000;
        const fadeOut = Math.max(0, Number(seg.seam?.out?.fadeMs ?? 16)) / 1000;
        const half = Math.max(durS / 2 - 0.001, 0.001);
        const fi = Math.min(fadeIn, half);
        const fo = Math.min(fadeOut, half);
        const stOut = Math.max(durS - fo, 0);
        const af = [
          "aformat=sample_rates=48000:channel_layouts=stereo",
          `afade=t=in:st=0:d=${fi.toFixed(3)}`,
          `afade=t=out:st=${stOut.toFixed(3)}:d=${fo.toFixed(3)}`,
        ].join(",");
        await runFfmpeg(
          ["-ss", ss.toFixed(3), "-i", media, "-t", durS.toFixed(3), "-vn", "-af", af, apath],
          ctx,
        );
      } else {
        await runFfmpeg(
          ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", durS.toFixed(3), apath],
          ctx,
        );
      }

      await runFfmpeg(
        [
          "-i",
          vpath,
          "-i",
          apath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-b:a",
          q.audioKbps,
          "-shortest",
          mpath,
        ],
        ctx,
      );
      chunks.push(mpath);
      ctx.log(
        `segment ${i + 1}/${segments.length} ${seg.id} role=${seg.role} ${durS.toFixed(3)}s audio=${Boolean(seg.hasAudio)}`,
      );
    }

    const listPath = path.join(tmpRoot, "list.txt");
    fs.writeFileSync(listPath, chunks.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const concatPath = path.join(tmpRoot, "concat.mp4");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", concatPath], ctx);

    const basePath = path.join(tmpRoot, "base.mp4");
    // One encode of the program/A-roll base: stable colorspace / continuous stream.
    await runFfmpeg(
      [
        "-i",
        concatPath,
        "-vf",
        filter,
        "-c:v",
        "libx264",
        "-preset",
        q.preset,
        "-crf",
        String(q.crf),
        "-pix_fmt",
        "yuv420p",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-c:a",
        "aac",
        "-b:a",
        q.audioKbps,
        "-movflags",
        "+faststart",
        basePath,
      ],
      ctx,
    );

    const finalTmp = path.join(tmpRoot, "final.mp4");
    if (wantsDialog && dialogDir) {
      await composeProgramLayers({
        baseMp4: basePath,
        outMp4: finalTmp,
        dialogDir,
        dialog: dialogCues,
        durationMs,
        fps,
        width,
        height,
        burnCaptions,
        captions,
        look,
        quality: q,
        tmpRoot,
        ctx,
      });
      ctx.log(
        `video program layers dialog=${rel(ctx, dialogDir)} captions=${burnCaptions ? "ass-typewriter" : "off"} cues=${dialogCues.length}`,
      );
    } else if (basis === "program" && burnCaptions && captions.length) {
      // Program without dialog chrome: still burn ASS onto the base.
      const assPath = path.join(tmpRoot, "program-typewriter.ass");
      fs.writeFileSync(
        assPath,
        buildAssFromCaptions(captions, style?.style === "plain" ? "plain" : "typewriter", look),
        "utf8",
      );
      const escapeAssPath = (pp: string) =>
        pp.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
      await runFfmpeg(
        [
          "-i",
          basePath,
          "-vf",
          `ass='${escapeAssPath(assPath)}'`,
          "-c:v",
          "libx264",
          "-preset",
          q.preset,
          "-crf",
          String(q.crf),
          "-pix_fmt",
          "yuv420p",
          "-colorspace",
          "bt709",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-color_range",
          "tv",
          "-c:a",
          "copy",
          "-movflags",
          "+faststart",
          finalTmp,
        ],
        ctx,
      );
      ctx.log(`video program captions=ass-typewriter (no dialog overlay)`);
    } else {
      fs.copyFileSync(basePath, finalTmp);
    }

    // Mix timeline.bgm under whatever program/A-roll we just built.
    let publishPath = finalTmp;
    if (bgmAbs && bgmVolume > 0) {
      const mixedPath = path.join(tmpRoot, "with-bgm.mp4");
      await mixBgmUnderProgram({
        baseMp4: finalTmp,
        outMp4: mixedPath,
        bgmAbs,
        durationMs,
        startMs: bgmStartMs,
        endMs: bgmEndMs,
        loop: bgmLoop,
        volume: bgmVolume,
        quality: q,
        ctx,
      });
      publishPath = mixedPath;
      ctx.log(
        `video bgm=${rel(ctx, bgmAbs)} window=${bgmStartMs}-${bgmEndMs}ms volume=${bgmVolume.toFixed(2)} loop=${bgmLoop}`,
      );
    }

    ensureDir(path.dirname(output.path));
    publishFileOutput(ctx, output, publishPath);
    ctx.log(
      `video basis=${basis} quality=${quality} ${width}x${height}@${fps} → ${rel(ctx, output.path)}`,
    );
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
