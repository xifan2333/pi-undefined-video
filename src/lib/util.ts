/**
 * Shared utilities. Library code throws UvidError; only adapters exit the process.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Expected, user-facing failure (bad input, missing file, tool failure). */
export class UvidError extends Error {}

export function fail(message: string): never {
  throw new UvidError(message);
}

/**
 * Execution context shared by the CLI and the pi extension.
 *
 * - `log` → diagnostics only (CLI: stderr; extension: collected into tool text)
 * - main artifact never goes through `log` when writing to a file/stdout;
 *   use `src/lib/io.ts` writers instead
 */
export interface Ctx {
  cwd: string;
  log: (line: string) => void;
  signal?: AbortSignal;
  /**
   * When true (pi tool host), omit-input/omit-output defaults that rely on
   * process stdio are restricted — tools should pass explicit paths.
   */
  toolHost?: boolean;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function resolvePath(ctx: Ctx, p: string): string {
  return path.resolve(ctx.cwd, p);
}

export function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error: any) {
    fail(`cannot read JSON ${file}: ${error?.message || error}`);
  }
}

/** camelCase → kebab-case (fontSize → font-size). */
export function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function rel(ctx: Ctx, p: string): string {
  return path.relative(ctx.cwd, p) || ".";
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function copyFileChecked(src: string, dest: string): void {
  if (!fs.existsSync(src)) fail(`source does not exist: ${src}`);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/** Package root (…/pi-undefined-video) for templates/ + assets/. */
export function packageRoot(): string {
  // src/lib/util.ts → ../../
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}
