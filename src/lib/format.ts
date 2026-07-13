/**
 * Output media formats for generate/* audio (and optional video keep).
 *
 * Default audio = mp3 (smaller intermediates for later stages).
 * Override with -f / --format, or by -o extension.
 */
import path from "node:path";
import { fail } from "./util.ts";

/** Audio-only containers/codecs. */
export type AudioFormat = "mp3" | "wav" | "aac";
/** Full set accepted by generate media writers. */
export type MediaFormat = AudioFormat | "mp4";

const AUDIO_FORMATS = new Set<string>(["mp3", "wav", "aac"]);
const ALL_FORMATS = new Set<string>(["mp3", "wav", "aac", "mp4"]);

const EXT_TO_FORMAT: Record<string, MediaFormat> = {
  ".mp3": "mp3",
  ".wav": "wav",
  ".aac": "aac",
  ".m4a": "aac",
  ".mp4": "mp4",
  ".m4v": "mp4",
};

export function isAudioFormat(f: MediaFormat): f is AudioFormat {
  return AUDIO_FORMATS.has(f);
}

export function formatExt(f: MediaFormat): string {
  switch (f) {
    case "mp3":
      return ".mp3";
    case "wav":
      return ".wav";
    case "aac":
      return ".m4a";
    case "mp4":
      return ".mp4";
  }
}

/** ffmpeg args after filters for audio encode (no -i / no output path). */
export function audioEncodeArgs(
  f: AudioFormat,
  opts: { bitrate?: string; sampleRate?: number } = {},
): string[] {
  const sampleRate = opts.sampleRate ?? 48000;
  const bitrate = (opts.bitrate ?? "192k").trim() || "192k";
  switch (f) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-b:a", bitrate, "-ar", String(sampleRate), "-ac", "2"];
    case "wav":
      return ["-c:a", "pcm_s16le", "-ar", String(sampleRate), "-ac", "2"];
    case "aac":
      return ["-c:a", "aac", "-b:a", bitrate, "-ar", String(sampleRate), "-ac", "2"];
  }
}

/**
 * Resolve output format:
 *   1. explicit -f / --format
 *   2. -o file extension
 *   3. default (mp3 for audio pipeline)
 */
export function resolveFormat(opts: {
  format?: string;
  outputPath?: string | null;
  defaultFormat?: MediaFormat;
}): MediaFormat {
  const def = opts.defaultFormat ?? "mp3";
  if (opts.format != null && String(opts.format).trim() !== "") {
    const f = String(opts.format).trim().toLowerCase();
    // accept common aliases
    const alias: Record<string, MediaFormat> = {
      mp3: "mp3",
      mpeg3: "mp3",
      wav: "wav",
      wave: "wav",
      aac: "aac",
      m4a: "aac",
      mp4: "mp4",
    };
    const hit = alias[f];
    if (!hit || !ALL_FORMATS.has(hit)) {
      fail(`unsupported format: ${opts.format} (use mp3|wav|aac|mp4)`);
    }
    return hit;
  }
  if (opts.outputPath) {
    const ext = path.extname(opts.outputPath).toLowerCase();
    const fromExt = EXT_TO_FORMAT[ext];
    if (fromExt) return fromExt;
  }
  return def;
}
