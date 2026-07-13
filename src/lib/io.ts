/**
 * Unified single-stream I/O for uvid filters.
 *
 * Contract:
 *   -i PATH  → read that file
 *   (no -i)  → read stdin  (CLI only; tool host must pass -i)
 *   -o PATH  → write main artifact to that file; stdout prints absolute path
 *   (no -o)  → write main artifact bytes/text to stdout (CLI)
 *   stderr / ctx.log → diagnostics only
 *
 * Shell pipes and redirections are the pipe mechanism — not a special `-` path.
 * Directory-level batching is out of scope: one invocation = one input + one output.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Ctx, ensureDir, fail, rel, resolvePath } from "./util.ts";

export type IoKind = "json" | "text" | "binary";

export interface ResolvedInput {
  /** Absolute path when input is a file; null when streaming stdin. */
  path: string | null;
  /** Human label for reports. */
  label: string;
  fromStdin: boolean;
}

export interface ResolvedOutput {
  /** Absolute path when output is a file; null when streaming stdout. */
  path: string | null;
  toStdout: boolean;
}

function stdinIsTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

function stdoutIsTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

/** Resolve optional -i. Media filters that need a seekable path call materializeInput(). */
export function resolveInput(ctx: Ctx, input: string | undefined, label = "input"): ResolvedInput {
  if (input !== undefined && input !== "") {
    const abs = resolvePath(ctx, input);
    if (!fs.existsSync(abs)) fail(`${label} does not exist: ${input}`);
    if (fs.statSync(abs).isDirectory()) {
      fail(`${label} is a directory (uvid is single-file only): ${input}`);
    }
    return { path: abs, label: rel(ctx, abs), fromStdin: false };
  }

  if (ctx.toolHost) {
    fail(`${label} required in tool host (pass input path; stdin is not available)`);
  }
  if (stdinIsTty()) {
    fail(`${label} missing: pass -i FILE, or pipe data on stdin`);
  }
  // Non-TTY empty stdin (e.g. no pipe attached) is still "stdin"; materialize/read will fail clearly.
  return { path: null, label: "stdin", fromStdin: true };
}

/** Resolve optional -o. */
export function resolveOutput(ctx: Ctx, output: string | undefined, opts: { binary?: boolean } = {}): ResolvedOutput {
  if (output !== undefined && output !== "") {
    const abs = resolvePath(ctx, output);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      fail(`output is a directory (uvid is single-file only): ${output}`);
    }
    return { path: abs, toStdout: false };
  }

  if (ctx.toolHost) {
    // Tool host: no real process stdout for the model; caller will emit via log/result.
    return { path: null, toStdout: true };
  }

  if (opts.binary && stdoutIsTty()) {
    fail("output missing: pass -o FILE (refusing to write binary to a TTY)");
  }
  return { path: null, toStdout: true };
}

/**
 * Ensure a filesystem path for tools that cannot stream (ffmpeg seek, etc.).
 * If input is already a file, return it. If stdin, spool to a temp file.
 * Caller must call cleanup() when done.
 */
export async function materializeInput(
  ctx: Ctx,
  input: ResolvedInput,
  opts: { ext?: string } = {},
): Promise<{ path: string; cleanup: () => void }> {
  if (input.path) {
    return { path: input.path, cleanup: () => {} };
  }

  const ext = opts.ext ?? ".bin";
  const tmp = path.join(os.tmpdir(), `uvid-stdin-${process.pid}-${Date.now()}${ext}`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    process.stdin.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);
    process.stdin.on("error", reject);
  });
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    fail("input missing or empty stdin: pass -i FILE, or pipe data on stdin");
  }
  return {
    path: tmp,
    cleanup: () => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Read full input as UTF-8 text (file or stdin). */
export async function readInputText(ctx: Ctx, input: ResolvedInput): Promise<string> {
  if (input.path) return fs.readFileSync(input.path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Read full input as JSON (file or stdin). */
export async function readInputJson(ctx: Ctx, input: ResolvedInput): Promise<any> {
  const text = await readInputText(ctx, input);
  try {
    return JSON.parse(text);
  } catch (error: any) {
    fail(`invalid JSON from ${input.label}: ${error?.message || error}`);
  }
}

/**
 * Emit one absolute path for a written product (file or directory).
 * When main artifact is on disk (-o), stdout prints the absolute path (one line).
 * Multiple products → call once per path (stdout: one path per line).
 * Diagnostics stay on stderr via ctx.log.
 * Tool host: path is logged; no process.stdout (model reads log/result).
 */
export function emitWrittenPath(ctx: Ctx, absPath: string): void {
  const abs = path.resolve(absPath);
  ctx.log(`wrote ${rel(ctx, abs)}`);
  if (ctx.toolHost) {
    ctx.log(abs);
    return;
  }
  process.stdout.write(abs + "\n");
}

/** Write JSON main artifact to -o file, stdout, or tool result stream via log. */
export function writeJsonOutput(ctx: Ctx, output: ResolvedOutput, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2) + "\n";
  if (output.path) {
    ensureDir(path.dirname(output.path));
    fs.writeFileSync(output.path, text);
    emitWrittenPath(ctx, output.path);
    return;
  }
  if (ctx.toolHost) {
    // Model-visible result: emit payload text through log collector.
    ctx.log(text.trimEnd());
    return;
  }
  process.stdout.write(text);
}

/** Write binary main artifact. */
export function writeBinaryOutput(ctx: Ctx, output: ResolvedOutput, data: Buffer): void {
  if (output.path) {
    ensureDir(path.dirname(output.path));
    fs.writeFileSync(output.path, data);
    emitWrittenPath(ctx, output.path);
    return;
  }
  if (ctx.toolHost) {
    fail("binary output requires -o FILE in tool host");
  }
  process.stdout.write(data);
}

/** Copy a produced file to the resolved output (for ffmpeg that must write a path). */
export function publishFileOutput(ctx: Ctx, output: ResolvedOutput, producedPath: string): void {
  if (output.path) {
    ensureDir(path.dirname(output.path));
    if (path.resolve(producedPath) !== path.resolve(output.path)) {
      fs.copyFileSync(producedPath, output.path);
    }
    emitWrittenPath(ctx, output.path);
    return;
  }
  if (ctx.toolHost) {
    fail("binary output requires -o FILE in tool host");
  }
  const data = fs.readFileSync(producedPath);
  process.stdout.write(data);
}

/** Shared optional -i / -o TypeBox field helpers live in spec; this is the runtime pair. */
export function openFilterIo(
  ctx: Ctx,
  params: { input?: string; output?: string },
  opts: { binaryOutput?: boolean; inputLabel?: string } = {},
): { input: ResolvedInput; output: ResolvedOutput } {
  return {
    input: resolveInput(ctx, params.input, opts.inputLabel ?? "input"),
    output: resolveOutput(ctx, params.output, { binary: opts.binaryOutput }),
  };
}
