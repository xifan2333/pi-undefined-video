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

export async function videoFrames(file: string, fps: number, opts: ExecOpts = {}): Promise<number> {
  const out = await probe(
    file,
    ["-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"],
    opts,
  );
  const n = Number.parseInt(out, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return Math.round((await mediaDurationMs(file, opts)) / 1000 * fps);
}

export async function hasVideoStream(file: string, opts: ExecOpts = {}): Promise<boolean> {
  try {
    const out = await probe(file, ["-select_streams", "v:0", "-show_entries", "stream=index", "-of", "csv=p=0"], opts);
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Decode any media to mono s16le PCM samples. */
export async function decodeMonoPcm(input: string, sampleRate: number, opts: ExecOpts = {}): Promise<Int16Array> {
  const buf = await execBuffer(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "pipe:1"],
    opts,
  );
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** loudnorm first pass: measure input loudness, return the parsed JSON stats. */
export async function loudnormMeasure(
  input: string,
  targetLufs: number,
  truePeak: number,
  lra: number,
  opts: ExecOpts = {},
): Promise<any> {
  const log = await ffmpeg(
    ["-i", input, "-af", `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:print_format=json`, "-f", "null", "-"],
    opts,
  );
  const match = log.match(/\{[\s\S]*?"target_offset"\s*:\s*"[^"]+"[\s\S]*?\}/);
  if (!match) throw new UvidError("could not parse loudnorm first-pass JSON");
  return JSON.parse(match[0]);
}
