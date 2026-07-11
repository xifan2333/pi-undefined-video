/**
 * uvid shared utilities. Library code must throw UvidError instead of exiting;
 * only the CLI entry decides process exit codes.
 */
import fs from "node:fs";
import path from "node:path";

/** Expected, user-facing failure (bad input, missing file, tool failure). */
export class UvidError extends Error {}

export function fail(message: string): never {
  throw new UvidError(message);
}

/** Execution context shared by the CLI and the pi extension. */
export interface Ctx {
  /** Base directory for resolving relative paths. */
  cwd: string;
  /** Line-oriented human-readable output sink. */
  log: (line: string) => void;
  /** Abort signal for cancellation (pi tool calls). */
  signal?: AbortSignal;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function copyFileChecked(src: string, dst: string): void {
  if (!fs.existsSync(src)) fail(`missing file: ${src}`);
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

export function resolvePath(ctx: Ctx, p: string): string {
  return path.resolve(ctx.cwd, p);
}

export function resolveExisting(ctx: Ctx, p: string, label: string): string {
  const abs = resolvePath(ctx, p);
  if (!fs.existsSync(abs)) fail(`${label} does not exist: ${p}`);
  return abs;
}

export function resolveAgainst(baseFile: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(path.dirname(baseFile), maybeRelative);
}

export function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    fail(`cannot read JSON ${file}: ${error?.message || error}`);
  }
}

export function writeJson(file: string, payload: any): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
}

/** Write JSON to a file when outputPath is set, otherwise emit through ctx.log. */
export function outputJson(ctx: Ctx, payload: any, outputPath: string | null | undefined): void {
  if (outputPath) {
    const out = resolvePath(ctx, outputPath);
    writeJson(out, payload);
    ctx.log(`wrote ${path.relative(ctx.cwd, out)}`);
  } else {
    ctx.log(JSON.stringify(payload, null, 2));
  }
}

export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c: string) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] as string));
}

/** camelCase → kebab-case (fontSize → font-size). */
export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function rel(ctx: Ctx, p: string): string {
  return path.relative(ctx.cwd, p) || ".";
}
