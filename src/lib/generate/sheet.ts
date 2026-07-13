/**
 * uvid generate sheet — images → one contact-sheet image.
 *
 * Multi-image input (positionals / --list) → single image output (-o or stdout).
 * Does not open a viewer — use mpv / imv to look at the result.
 *
 * Scaling: omit --cell-width/--cell-height → native pixel size per cell.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishFileOutput, resolveOutput } from "../io.ts";
import { collectPaths, requireBin, resolveMedia, titleFromPath } from "../media-paths.ts";
import { exec } from "../proc.ts";
import { type Ctx, ensureDir, fail, rel } from "../util.ts";

export interface GenerateSheetParams {
  input?: string;
  output?: string;
  paths?: string[];
  list?: string;
  /** Montage grid e.g. "4x2" or "3x"; omit = auto. */
  tile?: string;
  /** Max cell width; omit with cellHeight = no resize. */
  cellWidth?: number;
  /** Max cell height; omit with cellWidth = no resize. */
  cellHeight?: number;
  gap?: number;
  labelPad?: number;
  title?: string;
  font?: string;
  pointSize?: number;
}

function montageGeometry(p: GenerateSheetParams): string {
  const gap = p.gap != null && Number.isFinite(p.gap) ? Math.max(0, Math.floor(p.gap)) : 12;
  const labelPad =
    p.labelPad != null && Number.isFinite(p.labelPad) ? Math.max(0, Math.floor(p.labelPad)) : 28;
  const w = p.cellWidth != null && Number.isFinite(p.cellWidth) ? Math.floor(p.cellWidth) : undefined;
  const h = p.cellHeight != null && Number.isFinite(p.cellHeight) ? Math.floor(p.cellHeight) : undefined;
  if (w != null && w <= 0) fail(`invalid cellWidth: ${p.cellWidth}`);
  if (h != null && h <= 0) fail(`invalid cellHeight: ${p.cellHeight}`);
  if (w == null && h == null) return `+${gap}+${labelPad}`;
  return `${w != null ? String(w) : ""}x${h != null ? String(h) : ""}+${gap}+${labelPad}`;
}

function autoTile(n: number): string {
  if (n <= 1) return "1x1";
  if (n <= 3) return `${n}x1`;
  if (n <= 4) return "2x2";
  if (n <= 6) return "3x2";
  if (n <= 9) return "3x3";
  if (n <= 12) return "4x3";
  return `${Math.ceil(Math.sqrt(n))}x`;
}

export async function generateSheet(p: GenerateSheetParams, ctx: Ctx): Promise<void> {
  requireBin("magick");
  const files = collectPaths(p, ctx);
  if (files.length === 0) {
    fail("generate sheet needs image files: FILE… / -i / --list");
  }

  const items = await resolveMedia(files, ctx);
  if (items.some((i) => i.kind !== "image")) {
    fail("generate sheet only accepts images (extract stills first)");
  }

  const geometry = montageGeometry(p);
  const tile = (p.tile && p.tile.trim()) || autoTile(items.length);
  const font = p.font?.trim() || "FreeSans";
  const pointSize =
    p.pointSize != null && Number.isFinite(p.pointSize) ? Math.max(1, Math.floor(p.pointSize)) : 16;

  const output = resolveOutput(ctx, p.output, { binary: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uvid-sheet-"));
  const produced = path.join(tmpDir, "sheet.jpg");

  const args: string[] = ["montage"];
  for (const it of items) {
    args.push("-label", it.title || titleFromPath(it.path), it.path);
  }
  args.push(
    "-tile",
    tile,
    "-geometry",
    geometry,
    "-font",
    font,
    "-pointsize",
    String(pointSize),
    "-fill",
    "#f2f2f2",
    "-background",
    "#0e0e0e",
    "-bordercolor",
    "#2a2a2a",
    "-frame",
    "1",
  );
  if (p.title?.trim()) args.push("-title", p.title.trim());
  args.push(produced);

  const scaleHint =
    p.cellWidth == null && p.cellHeight == null
      ? "scale=native"
      : `scale=${p.cellWidth ?? "?"}x${p.cellHeight ?? "?"}`;
  ctx.log(
    `generate sheet n=${items.length} tile=${tile} geometry=${geometry} ${scaleHint}` +
      (output.path ? ` → ${rel(ctx, output.path)}` : " → stdout"),
  );

  try {
    await exec("magick", args, { signal: ctx.signal, cwd: ctx.cwd });
    if (!fs.existsSync(produced)) fail(`sheet not written: ${produced}`);
    // If -o is set, magick can write there directly — but we always go via temp
    // then publish so stdout/toolHost paths stay consistent.
    if (output.path) ensureDir(path.dirname(output.path));
    publishFileOutput(ctx, output, produced);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
