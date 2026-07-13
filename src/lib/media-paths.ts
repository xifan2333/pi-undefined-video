/**
 * Multi-file path collection + light media typing for generate sheet.
 * Single-file filters still use lib/io.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { exec } from "./proc.ts";
import { type Ctx, fail, resolvePath } from "./util.ts";

export type MediaKind = "image" | "video" | "audio";

export interface PathListParams {
  input?: string;
  paths?: string[];
  list?: string;
}

export function titleFromPath(file: string): string {
  const stem = path.basename(file, path.extname(file));
  const m = /^t(\d+)_(\d+)$/.exec(stem);
  if (m) return `${Number(m[1])}.${m[2]}s`;
  const m2 = /^t(\d{6,})$/.exec(stem);
  if (m2) {
    const ms = Number(m2[1]);
    if (Number.isFinite(ms)) {
      const sec = ms / 1000;
      return Number.isInteger(sec) ? `${sec}s` : `${sec}s`;
    }
  }
  return stem;
}

export function collectPaths(p: PathListParams, ctx: Ctx): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const abs = resolvePath(ctx, raw);
    if (!fs.existsSync(abs)) fail(`path does not exist: ${raw}`);
    if (fs.statSync(abs).isDirectory()) {
      fail(`path is a directory (pass files, or use a shell glob): ${raw}`);
    }
    out.push(abs);
  };

  if (p.list) {
    const listPath = resolvePath(ctx, p.list);
    if (!fs.existsSync(listPath)) fail(`list file does not exist: ${p.list}`);
    for (const line of fs.readFileSync(listPath, "utf8").split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      push(s);
    }
  }
  if (p.input) push(p.input);
  if (p.paths?.length) {
    for (const raw of p.paths) push(raw);
  }

  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const f of out) {
    if (seen.has(f)) continue;
    seen.add(f);
    uniq.push(f);
  }
  return uniq;
}

export async function mimeOf(file: string, ctx: Ctx): Promise<string> {
  try {
    const { stdout } = await exec("file", ["-b", "--mime-type", file], { signal: ctx.signal });
    return stdout.trim().toLowerCase();
  } catch {
    return "";
  }
}

export function kindFromMime(mime: string, file: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  const ext = path.extname(file).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".jxl", ".heic"].includes(ext)) {
    return "image";
  }
  if ([".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".aac", ".flac", ".m4a", ".ogg", ".opus"].includes(ext)) return "audio";
  fail(`cannot classify media (mime=${mime || "?"}): ${file}`);
}

export async function resolveMedia(
  files: string[],
  ctx: Ctx,
): Promise<Array<{ path: string; title: string; kind: MediaKind }>> {
  const items = [];
  for (const file of files) {
    const mime = await mimeOf(file, ctx);
    items.push({ path: file, title: titleFromPath(file), kind: kindFromMime(mime, file) });
  }
  return items;
}

export function requireBin(bin: string): string {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* continue */
    }
  }
  fail(`${bin} not found on PATH`);
}
