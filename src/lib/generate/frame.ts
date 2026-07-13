/**
 * uvid generate frame — video + atMs → one still JPEG.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFilterIo, publishFileOutput } from "../io.ts";
import { ffmpeg } from "../proc.ts";
import { type Ctx, ensureDir, fail, rel } from "../util.ts";

export interface GenerateFrameParams {
  input?: string;
  output?: string;
  atMs: number;
  /** Output width; height auto (-2). Default 640. */
  width?: number;
  /** Explicit height; omit keeps aspect via -2. */
  height?: number;
  /**
   * JPEG quality for -q:v (2–31, lower = better). Default 3.
   * Ignored for non-jpeg paths if we ever extend formats.
   */
  quality?: number;
}

export async function generateFrame(p: GenerateFrameParams, ctx: Ctx): Promise<void> {
  if (!Number.isFinite(p.atMs) || p.atMs < 0) fail(`invalid atMs: ${p.atMs}`);
  const { input, output } = openFilterIo(ctx, p, { binaryOutput: true });
  if (input.fromStdin) {
    fail("generate frame requires -i FILE (seek needs a path; do not pipe the video)");
  }
  if (!input.path) fail("generate frame requires -i FILE");

  const width = p.width ?? 640;
  const height = p.height;
  const quality = p.quality ?? 3;
  if (!Number.isFinite(width) || width <= 0) fail(`invalid width: ${width}`);
  if (height != null && (!Number.isFinite(height) || height <= 0)) fail(`invalid height: ${height}`);
  if (!Number.isFinite(quality) || quality < 1 || quality > 31) {
    fail(`invalid quality: ${quality} (JPEG -q:v expects 1–31, lower=better)`);
  }

  const scale =
    height != null ? `scale=${Math.floor(width)}:${Math.floor(height)}` : `scale=${Math.floor(width)}:-2`;

  const tmpOut = output.path
    ? output.path
    : path.join(os.tmpdir(), `uvid-frame-${process.pid}-${Date.now()}.jpg`);

  ensureDir(path.dirname(tmpOut));
  await ffmpeg(
    [
      "-ss",
      (p.atMs / 1000).toFixed(3),
      "-i",
      input.path,
      "-frames:v",
      "1",
      "-vf",
      scale,
      "-q:v",
      String(Math.round(quality)),
      tmpOut,
    ],
    { signal: ctx.signal },
  );

  if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) {
    fail(`frame extract produced empty file at ${p.atMs}ms`);
  }

  publishFileOutput(ctx, output, tmpOut);
  if (!output.path) {
    try {
      fs.unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
  }
}
