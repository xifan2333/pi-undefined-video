/**
 * Final rendering from timeline.json using ffmpeg.
 *
 * This intentionally does not re-render HyperFrames. It consumes the rendered assets
 * produced by previous steps: clips/*.mp4, scenes/*.png, dialog/*.png, voice/SFX/BGM.
 */
import fs from "node:fs";
import path from "node:path";
import { type Ctx, ensureDir, fail, readJson, rel, resolveExisting, resolvePath } from "./util.ts";
import { exec } from "./proc.ts";

export interface VideoRenderFinalParams {
  input: string;
  output: string;
  subtitles?: string;
  workDir?: string;
  width?: number;
  height?: number;
  crf?: number;
  preset?: string;
  audioBitrate?: string;
  keepWork?: boolean;
}

function sec(frames: number, fps: number): number {
  return frames / fps;
}

function f(n: number): string {
  return Number(n).toFixed(3);
}

function resolveTimelineSource(timelineDir: string, source: string): string {
  return path.resolve(timelineDir, source);
}

function scalePad(labelIn: string, labelOut: string, width: number, height: number, fps: number): string {
  return `${labelIn}fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p${labelOut}`;
}

function assEscape(p: string): string {
  // Escape for ffmpeg filter option parsing (Linux paths).
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function runFfmpeg(args: string[], ctx: Ctx, timeoutMs = 30 * 60 * 1000): Promise<void> {
  await exec("ffmpeg", ["-hide_banner", "-y", ...args], { signal: ctx.signal, timeoutMs });
}

async function renderBaseVideo(timeline: any, timelineDir: string, workDir: string, width: number, height: number, ctx: Ctx): Promise<string> {
  const fps = timeline.fps;
  const v1 = (timeline.tracks || []).find((t: any) => t.id === "V1");
  if (!v1) fail("timeline missing V1 track");

  const args: string[] = [];
  const filters: string[] = [];
  const segLabels: string[] = [];
  let inputIndex = 0;
  let segIndex = 0;

  for (const clip of v1.clips || []) {
    const sourcePath = resolveTimelineSource(timelineDir, clip.source);
    if (!fs.existsSync(sourcePath)) fail(`render final: missing V1 source: ${sourcePath}`);

    if (clip.mode === "still") {
      const dur = sec(clip.durationFrames, fps);
      args.push("-loop", "1", "-t", f(dur), "-i", sourcePath);
      const out = `[v${segIndex}]`;
      filters.push(scalePad(`[${inputIndex}:v]trim=duration=${f(dur)},setpts=PTS-STARTPTS,`, out, width, height, fps));
      segLabels.push(out);
      inputIndex++;
      segIndex++;
      continue;
    }

    args.push("-i", sourcePath);
    if (clip.compound && Array.isArray(clip.sourceRanges)) {
      for (const r of clip.sourceRanges) {
        const start = r.sourceStartMs / 1000;
        const end = r.sourceEndMs / 1000;
        const hold = (r.holdAfterMs || 0) / 1000;
        const out = `[v${segIndex}]`;
        let chain = `[${inputIndex}:v]trim=start=${f(start)}:end=${f(end)},setpts=PTS-STARTPTS,`;
        chain += `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
        if (hold > 0) chain += `,tpad=stop_mode=clone:stop_duration=${f(hold)}`;
        chain += `,format=yuv420p${out}`;
        filters.push(chain);
        segLabels.push(out);
        segIndex++;
      }
    } else {
      const dur = sec(clip.durationFrames, fps);
      const out = `[v${segIndex}]`;
      filters.push(scalePad(`[${inputIndex}:v]trim=duration=${f(dur)},setpts=PTS-STARTPTS,`, out, width, height, fps));
      segLabels.push(out);
      segIndex++;
    }
    inputIndex++;
  }

  if (segLabels.length === 0) fail("V1 track has no clips");
  filters.push(`${segLabels.join("")}concat=n=${segLabels.length}:v=1:a=0[vout]`);

  const script = path.join(workDir, "base-video.fffilter");
  fs.writeFileSync(script, filters.join(";\n") + "\n");
  const output = path.join(workDir, "base-video.mp4");
  await runFfmpeg([...args, "-filter_complex_script", script, "-map", "[vout]", "-r", String(fps), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", output], ctx);
  return output;
}

async function renderAudioMix(timeline: any, timelineDir: string, workDir: string, ctx: Ctx): Promise<string> {
  const fps = timeline.fps;
  const totalSec = timeline.totalDurationMs / 1000;
  const clips = (timeline.tracks || [])
    .filter((t: any) => t.kind === "audio")
    .flatMap((t: any) => (t.clips || []).map((c: any) => ({ ...c, trackId: t.id })));

  const output = path.join(workDir, "audio-mix.wav");
  if (clips.length === 0) {
    await runFfmpeg(["-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`, "-t", f(totalSec), "-c:a", "pcm_s16le", output], ctx);
    return output;
  }

  const args: string[] = [];
  const filters: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const sourcePath = resolveTimelineSource(timelineDir, c.source);
    if (!fs.existsSync(sourcePath)) fail(`render final: missing audio source: ${sourcePath}`);
    args.push("-i", sourcePath);
    const delayMs = Math.round(sec(c.timelineStartFrame, fps) * 1000);
    const dur = sec(c.durationFrames, fps);
    filters.push(`[${i}:a]atrim=duration=${f(dur)},asetpts=PTS-STARTPTS,aresample=48000,adelay=${delayMs}:all=1[a${i}]`);
  }
  filters.push(`${clips.map((_c: any, i: number) => `[a${i}]`).join("")}amix=inputs=${clips.length}:duration=longest:normalize=0,atrim=duration=${f(totalSec)},alimiter=limit=0.98[out]`);

  const script = path.join(workDir, "audio-mix.fffilter");
  fs.writeFileSync(script, filters.join(";\n") + "\n");
  await runFfmpeg([...args, "-filter_complex_script", script, "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", output], ctx);
  return output;
}

async function createDialogSequence(timeline: any, timelineDir: string, workDir: string, width: number, height: number, ctx: Ctx): Promise<string> {
  const totalFrames = timeline.totalFrames;
  const dialogTrack = (timeline.tracks || []).find((t: any) => t.id === "V2_DIALOG");
  const clips = dialogTrack?.clips || [];
  const seqDir = path.join(workDir, "dialog-seq");
  ensureDir(seqDir);

  const transparent = path.join(workDir, "transparent.png");
  await runFfmpeg(["-f", "lavfi", "-i", `color=c=black@0.0:s=${width}x${height},format=rgba`, "-frames:v", "1", transparent], ctx);

  const frameSrc = new Array<string>(totalFrames).fill(transparent);
  for (const c of clips) {
    const p = resolveTimelineSource(timelineDir, c.source);
    if (!fs.existsSync(p)) fail(`render final: missing dialog source: ${p}`);
    const start = Math.max(0, c.timelineStartFrame);
    const end = Math.min(totalFrames, c.timelineStartFrame + c.durationFrames);
    for (let i = start; i < end; i++) frameSrc[i] = p;
  }

  for (let i = 0; i < totalFrames; i++) {
    const dst = path.join(seqDir, `frame_${String(i + 1).padStart(6, "0")}.png`);
    try { fs.symlinkSync(frameSrc[i], dst); }
    catch { fs.copyFileSync(frameSrc[i], dst); }
  }
  return path.join(seqDir, "frame_%06d.png");
}

async function renderFinalComposite(
  timeline: any,
  timelineDir: string,
  baseVideo: string,
  audioMix: string,
  subtitles: string | null,
  output: string,
  workDir: string,
  width: number,
  height: number,
  crf: number,
  preset: string,
  audioBitrate: string,
  ctx: Ctx,
): Promise<void> {
  const fps = timeline.fps;
  const totalSec = timeline.totalDurationMs / 1000;
  const dialogPattern = await createDialogSequence(timeline, timelineDir, workDir, width, height, ctx);

  const args: string[] = ["-i", baseVideo, "-framerate", String(fps), "-i", dialogPattern, "-i", audioMix];
  const filters: string[] = [];
  let cur = "[vdlg]";
  filters.push(`[0:v][1:v]overlay=0:0:format=auto${cur}`);
  if (subtitles) {
    filters.push(`${cur}subtitles=filename='${assEscape(subtitles)}':fontsdir='${assEscape(path.join(process.env.HOME || "", ".local/share/fonts"))}'[vsub]`);
    cur = "[vsub]";
  }
  filters.push(`${cur}trim=duration=${f(totalSec)},setpts=PTS-STARTPTS,scale=${width}:${height},format=yuv420p[vout]`);

  const script = path.join(workDir, "final-composite.fffilter");
  fs.writeFileSync(script, filters.join(";\n") + "\n");
  await runFfmpeg([
    ...args,
    "-filter_complex_script", script,
    "-map", "[vout]",
    "-map", "2:a",
    "-t", f(totalSec),
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", audioBitrate,
    "-movflags", "+faststart",
    output,
  ], ctx, 60 * 60 * 1000);
}

/** Render the final MP4 from timeline.json using ffmpeg. */
export async function videoRenderFinal(p: VideoRenderFinalParams, ctx: Ctx): Promise<void> {
  const timelinePath = resolveExisting(ctx, p.input, "input");
  const timeline = readJson(timelinePath);
  const timelineDir = path.dirname(timelinePath);
  const output = resolvePath(ctx, p.output);
  ensureDir(path.dirname(output));

  const workDir = p.workDir ? resolvePath(ctx, p.workDir) : path.join(path.dirname(output), ".render-final");
  fs.rmSync(workDir, { recursive: true, force: true });
  ensureDir(workDir);

  const width = p.width ?? 1280;
  const height = p.height ?? 720;
  const crf = p.crf ?? 18;
  const preset = p.preset ?? "veryfast";
  const audioBitrate = p.audioBitrate ?? "192k";

  ctx.log(`uvid deliver render: ${rel(ctx, timelinePath)} → ${rel(ctx, output)}`);
  ctx.log(`  ${width}x${height} ${timeline.fps}fps, ${(timeline.totalDurationMs / 1000).toFixed(2)}s`);
  ctx.log("  pass 1/3: V1 base video");
  const baseVideo = await renderBaseVideo(timeline, timelineDir, workDir, width, height, ctx);
  ctx.log("  pass 2/3: audio mix");
  const audioMix = await renderAudioMix(timeline, timelineDir, workDir, ctx);
  const subtitles = p.subtitles ? resolveExisting(ctx, p.subtitles, "--subtitles") : null;
  ctx.log("  pass 3/3: dialog overlay + subtitles + final encode");
  await renderFinalComposite(timeline, timelineDir, baseVideo, audioMix, subtitles, output, workDir, width, height, crf, preset, audioBitrate, ctx);

  if (!p.keepWork) fs.rmSync(workDir, { recursive: true, force: true });
  ctx.log(`uvid deliver render: wrote ${rel(ctx, output)}`);
}
