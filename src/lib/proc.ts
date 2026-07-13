/**
 * Async process helpers for ffmpeg/ffprobe and friends.
 * All functions honor an AbortSignal and throw UvidError with the stderr tail on failure.
 */
import { execFile } from "node:child_process";
import { UvidError } from "./util.ts";

const MAX_BUFFER = 256 * 1024 * 1024;

export interface ExecOpts {
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function tail(text: string, lines = 12): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/** Run a command, capture stdout/stderr as UTF-8, throw UvidError on non-zero exit. */
export function exec(cmd: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", maxBuffer: MAX_BUFFER, cwd: opts.cwd, signal: opts.signal, timeout: opts.timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as any).code === "ABORT_ERR") return reject(new UvidError(`${cmd} aborted`));
          return reject(new UvidError(`${cmd} ${args.slice(0, 4).join(" ")}… failed:\n${tail(String(stderr || error.message))}`));
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Run a command and capture stdout as a raw Buffer (for PCM pipes). */
export function execBuffer(cmd: string, args: string[], opts: ExecOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "buffer", maxBuffer: MAX_BUFFER, cwd: opts.cwd, signal: opts.signal },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as any).code === "ABORT_ERR") return reject(new UvidError(`${cmd} aborted`));
          return reject(new UvidError(`${cmd} failed:\n${tail(stderr ? stderr.toString("utf8") : error.message)}`));
        }
        resolve(stdout as unknown as Buffer);
      },
    );
  });
}

/** ffmpeg with standard quiet flags. Returns stderr (ffmpeg reports there). */
export async function ffmpeg(args: string[], opts: ExecOpts = {}): Promise<string> {
  const { stderr } = await exec("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], opts);
  return stderr;
}

export async function probe(file: string, args: string[], opts: ExecOpts = {}): Promise<string> {
  const { stdout } = await exec("ffprobe", ["-v", "error", ...args, file], opts);
  return stdout.trim();
}

export async function mediaDurationMs(file: string, opts: ExecOpts = {}): Promise<number> {
  const out = await probe(file, ["-show_entries", "format=duration", "-of", "csv=p=0"], opts);
  const n = Math.round(Number(out) * 1000);
  if (!Number.isFinite(n) || n < 0) throw new UvidError(`invalid duration for ${file}: ${out}`);
  return n;
}

export async function hasVideoStream(file: string, opts: ExecOpts = {}): Promise<boolean> {
  try {
    const out = await probe(file, ["-select_streams", "v:0", "-show_entries", "stream=index", "-of", "csv=p=0"], opts);
    return out.length > 0;
  } catch {
    return false;
  }
}

export async function hasAudioStream(file: string, opts: ExecOpts = {}): Promise<boolean> {
  try {
    const out = await probe(file, ["-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0"], opts);
    return out.length > 0;
  } catch {
    return false;
  }
}

export interface DecodePcmOpts extends ExecOpts {
  /** Inclusive start on source timeline (ms). */
  fromMs?: number;
  /** Exclusive end on source timeline (ms). */
  toMs?: number;
}

/** Decode any media to mono s16le PCM samples (optional half-open [fromMs, toMs)). */
export async function decodeMonoPcm(
  input: string,
  sampleRate: number,
  opts: DecodePcmOpts = {},
): Promise<Int16Array> {
  const fromMs = opts.fromMs != null && opts.fromMs > 0 ? Math.floor(opts.fromMs) : 0;
  const toMs = opts.toMs != null ? Math.floor(opts.toMs) : undefined;
  if (toMs != null && toMs <= fromMs) {
    throw new UvidError(`PCM window empty: fromMs=${fromMs} toMs=${toMs}`);
  }

  const args = ["-hide_banner", "-loglevel", "error", "-i", input, "-vn"];
  if (fromMs > 0) args.push("-ss", (fromMs / 1000).toFixed(3));
  if (toMs != null) args.push("-t", ((toMs - fromMs) / 1000).toFixed(3));
  args.push("-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1");

  const buf = await execBuffer("ffmpeg", args, opts);
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** Stats printed by loudnorm `print_format=json` (all values are strings). */
export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
  output_i?: string;
  output_tp?: string;
  output_lra?: string;
  output_thresh?: string;
  normalization_type?: string;
}

/** Pull the JSON object ffmpeg dumps after the loudnorm filter. */
function parseLoudnormJson(log: string): LoudnormMeasure {
  const start = log.lastIndexOf("{");
  const end = log.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new UvidError("could not find loudnorm first-pass JSON in ffmpeg output");
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(log.slice(start, end + 1));
  } catch (e) {
    throw new UvidError(`loudnorm JSON parse failed: ${(e as Error).message}`);
  }
  const need = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
  for (const key of need) {
    if (typeof raw[key] !== "string") {
      throw new UvidError(`loudnorm JSON missing field: ${key}`);
    }
  }
  return raw as unknown as LoudnormMeasure;
}

export interface LoudnormMeasureOpts extends ExecOpts {
  /** Inclusive start on source timeline (ms). */
  fromMs?: number;
  /** Exclusive end on source timeline (ms). */
  toMs?: number;
}

/** loudnorm first pass: measure input loudness, return the parsed JSON stats. */
export async function loudnormMeasure(
  input: string,
  targetLufs: number,
  truePeak: number,
  lra: number,
  opts: LoudnormMeasureOpts = {},
): Promise<LoudnormMeasure> {
  const fromMs = opts.fromMs != null && opts.fromMs > 0 ? Math.floor(opts.fromMs) : 0;
  const toMs = opts.toMs != null ? Math.floor(opts.toMs) : undefined;
  if (toMs != null && toMs <= fromMs) {
    throw new UvidError(`loudnorm window empty: fromMs=${fromMs} toMs=${toMs}`);
  }

  const args: string[] = [];
  if (fromMs > 0) args.push("-ss", (fromMs / 1000).toFixed(3));
  if (toMs != null) args.push("-t", ((toMs - fromMs) / 1000).toFixed(3));
  args.push(
    "-i",
    input,
    "-af",
    `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:print_format=json`,
    "-f",
    "null",
    "-",
  );

  const log = await ffmpeg(args, opts);
  return parseLoudnormJson(log);
}
