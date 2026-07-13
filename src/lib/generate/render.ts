/**
 * uvid generate render — HyperFrames scene dir → one media product.
 *
 * Formats:
 *   mp4 | webm | mov | gif     → hyperframes render → one file
 *   png-sequence               → hyperframes render → one directory of PNGs
 *   png                        → hyperframes snapshot → one still PNG (fast path for static cards)
 *   sprite                     → dialog scene → one directory of 4 named RGBA PNGs
 *
 *   uvid generate render -i scenes/intro -o clips/intro.mp4
 *   uvid generate render -i scenes/dialog -o clips/dialog -f sprite
 *   uvid generate render -i cache/01/scene -o cache/01/visual.png -f png
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitWrittenPath } from "../io.ts";
import { exec } from "../proc.ts";
import { type Ctx, ensureDir, fail, rel, resolvePath } from "../util.ts";

const FORMATS = ["mp4", "webm", "mov", "gif", "png-sequence", "png", "sprite"] as const;
export type RenderFormat = (typeof FORMATS)[number];

/** Dialog chrome product states (talk-closed doubles as wait blink-off). */
export const DIALOG_STATES = ["idle", "talk-closed", "talk-open", "wait-on"] as const;
export type DialogState = (typeof DIALOG_STATES)[number];

export interface GenerateRenderParams {
  input?: string;
  output?: string;
  /** mp4 | webm | mov | gif | png-sequence | png | sprite. Default mp4 (or from -o ext). */
  format?: string;
  fps?: number;
  /** draft | standard | high. Default high. Video formats only. */
  quality?: string;
  /** Parallel workers; default 1. Video formats only. */
  workers?: number;
  /**
   * Still capture time in ms for format=png (default 0).
   * Mapped to hyperframes snapshot --at <sec>.
   */
  atMs?: number;
}

function normalizeFormat(raw: string | undefined, outPath: string): RenderFormat {
  let f = (raw || "").trim().toLowerCase();
  if (!f) {
    const ext = path.extname(outPath).toLowerCase().replace(/^\./, "");
    if (ext === "mp4" || ext === "webm" || ext === "mov" || ext === "gif" || ext === "png") f = ext;
    else f = "mp4";
  }
  if (!(FORMATS as readonly string[]).includes(f)) {
    fail(`unsupported format: ${raw} (mp4|webm|mov|gif|png-sequence|png|sprite)`);
  }
  return f as RenderFormat;
}

function listPngs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /\.png$/i.test(n))
    .map((n) => path.join(dir, n))
    .sort();
}

function listPngsRecursive(dir: string): string[] {
  const direct = listPngs(dir);
  if (direct.length) return direct;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => listPngs(path.join(dir, d.name)))
    .sort();
}

function setDialogState(html: string, state: string): string {
  if (/data-state="[^"]*"/.test(html)) {
    return html.replace(/data-state="[^"]*"/, `data-state="${state}"`);
  }
  // Prefer attaching next to composition id.
  if (/data-composition-id="rpg-dialog"/.test(html)) {
    return html.replace(
      /data-composition-id="rpg-dialog"/,
      `data-composition-id="rpg-dialog" data-state="${state}"`,
    );
  }
  return html.replace(/<div id="root"/, `<div id="root" data-state="${state}"`);
}

function isDialogScene(sceneDir: string): boolean {
  const htmlPath = path.join(sceneDir, "index.html");
  if (!fs.existsSync(htmlPath)) return false;
  const html = fs.readFileSync(htmlPath, "utf8");
  return (
    /data-composition-id="rpg-dialog"/.test(html) ||
    /DIALOG_STATES/.test(html) ||
    /data-state=/.test(html)
  );
}

async function renderDialogStates(
  sceneDir: string,
  outDir: string,
  quality: string,
  workers: number,
  ctx: Ctx,
): Promise<void> {
  if (!isDialogScene(sceneDir)) {
    fail("format=sprite requires a dialog scene (rpg-dialog / data-state)");
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  const srcHtml = fs.readFileSync(path.join(sceneDir, "index.html"), "utf8");
  ctx.log(
    `generate render scene=${rel(ctx, sceneDir)} format=sprite states=${DIALOG_STATES.join(",")} → ${rel(ctx, outDir)}`,
  );

  for (const state of DIALOG_STATES) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `uvid-dialog-${state}-`));
    const framesDir = path.join(workDir, "frames");
    try {
      // Materialize a temp scene: copy assets + patched index with fixed data-state.
      // Keep relative asset paths working.
      for (const name of fs.readdirSync(sceneDir)) {
        const from = path.join(sceneDir, name);
        const to = path.join(workDir, name);
        fs.cpSync(from, to, { recursive: true });
      }
      fs.writeFileSync(path.join(workDir, "index.html"), setDialogState(srcHtml, state));

      // png-sequence keeps true RGBA; snapshot flattens to opaque white.
      await exec(
        "hyperframes",
        [
          "render",
          workDir,
          "--format",
          "png-sequence",
          "--output",
          framesDir,
          "--fps",
          "25",
          "--quality",
          quality,
          "--workers",
          String(Math.floor(workers)),
        ],
        { signal: ctx.signal, timeoutMs: 10 * 60 * 1000 },
      );

      const frames = listPngsRecursive(framesDir).filter(
        (f) => !/contact-sheet/i.test(path.basename(f)),
      );
      if (frames.length === 0) fail(`sprite produced no PNG for state=${state}`);
      const dest = path.join(outDir, `${state}.png`);
      fs.copyFileSync(frames[0], dest);
      if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
        fail(`sprite empty/missing: ${dest}`);
      }
      ctx.log(`generate render state=${state} size=${fs.statSync(dest).size}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  for (const state of DIALOG_STATES) {
    const p = path.join(outDir, `${state}.png`);
    if (!fs.existsSync(p)) fail(`sprite missing required file: ${state}.png`);
  }
}

async function renderStillPng(
  sceneDir: string,
  outPath: string,
  atMs: number,
  ctx: Ctx,
): Promise<void> {
  if (!Number.isFinite(atMs) || atMs < 0) fail(`invalid --at-ms: ${atMs}`);
  const atSec = atMs / 1000;
  ensureDir(path.dirname(outPath));
  if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
    fail(`-o is a directory but format=png needs a file path`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uvid-render-png-"));
  try {
    ctx.log(
      `generate render scene=${rel(ctx, sceneDir)} format=png atMs=${atMs} → ${rel(ctx, outPath)}`,
    );
    // Snapshot is the light still path; full `hyperframes render` is for video/sequence.
    await exec(
      "hyperframes",
      [
        "snapshot",
        sceneDir,
        "-o",
        tmpDir,
        "--at",
        String(atSec),
        "--frames",
        "1",
        "--no-end",
        "--describe",
        "false",
      ],
      { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 },
    );

    const frames = listPngsRecursive(tmpDir).filter(
      // contact-sheet.jpg is not a still; also skip non-frame names if any
      (f) => !/contact-sheet/i.test(path.basename(f)),
    );
    if (frames.length === 0) fail(`format=png produced no PNG under snapshot temp dir`);
    const still = frames[0];
    fs.copyFileSync(still, outPath);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fail(`format=png produced empty/missing file: ${outPath}`);
    }
    ctx.log(`generate render size=${fs.statSync(outPath).size}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function generateRender(p: GenerateRenderParams, ctx: Ctx): Promise<void> {
  if (!p.input) fail("generate render requires -i SCENE_DIR");
  if (!p.output) fail("generate render requires -o FILE_OR_DIR");

  const sceneDir = resolvePath(ctx, p.input);
  if (!fs.existsSync(sceneDir) || !fs.statSync(sceneDir).isDirectory()) {
    fail(`scene directory does not exist: ${p.input}`);
  }
  if (!fs.existsSync(path.join(sceneDir, "index.html"))) {
    fail(`not a HyperFrames scene (missing index.html): ${p.input}`);
  }

  const outPath = resolvePath(ctx, p.output);
  const format = normalizeFormat(p.format, outPath);

  if (format === "png") {
    await renderStillPng(sceneDir, outPath, p.atMs ?? 0, ctx);
    emitWrittenPath(ctx, outPath);
    return;
  }

  const fps = p.fps ?? 25;
  const quality = (p.quality || "high").trim();
  const workers = p.workers ?? 1;
  if (!Number.isFinite(fps) || fps <= 0) fail(`invalid fps: ${p.fps}`);
  if (!Number.isFinite(workers) || workers < 1) fail(`invalid workers: ${p.workers}`);

  if (format === "sprite") {
    if (fs.existsSync(outPath) && !fs.statSync(outPath).isDirectory()) {
      fail(`-o must be a directory for format=sprite`);
    }
    await renderDialogStates(sceneDir, outPath, quality, workers, ctx);
    emitWrittenPath(ctx, outPath);
    return;
  }

  if (format === "png-sequence") {
    fs.rmSync(outPath, { recursive: true, force: true });
    ensureDir(outPath);
  } else {
    ensureDir(path.dirname(outPath));
    if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) {
      fail(`-o is a directory but format=${format} needs a file path`);
    }
  }

  ctx.log(
    `generate render scene=${rel(ctx, sceneDir)} format=${format} fps=${fps} quality=${quality} workers=${workers} → ${rel(ctx, outPath)}`,
  );

  await exec(
    "hyperframes",
    [
      "render",
      sceneDir,
      "--format",
      format,
      "--output",
      outPath,
      "--fps",
      String(Math.floor(fps)),
      "--quality",
      quality,
      "--workers",
      String(Math.floor(workers)),
    ],
    { signal: ctx.signal, timeoutMs: 30 * 60 * 1000 },
  );

  if (format === "png-sequence") {
    const frames = listPngs(outPath);
    if (frames.length === 0) {
      const nested = listPngsRecursive(outPath);
      if (nested.length === 0) fail(`png-sequence produced no PNGs under ${outPath}`);
      ctx.log(`generate render note: frames nested (${nested.length})`);
    } else {
      ctx.log(`generate render frames=${frames.length}`);
    }
  } else {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fail(`render produced empty/missing file: ${outPath}`);
    }
    ctx.log(`generate render size=${fs.statSync(outPath).size}`);
  }

  emitWrittenPath(ctx, outPath);
}

/** @deprecated alias — use generateRender */
export const generateSequence = generateRender;
export type GenerateSequenceParams = GenerateRenderParams;
