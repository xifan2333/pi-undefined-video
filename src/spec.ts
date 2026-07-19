/**
 * uvid command spec — single source of truth for CLI + pi tools.
 *
 * Two families of single-stream filters:
 *   analyze  — evidence: input → one JSON
 *   generate — artifact: input → one media/file
 *
 * I/O:
 *   -i FILE  read file; omit → stdin (CLI)
 *   -o FILE  write main artifact to that path; stdout prints the absolute path
 *            omit -o → main artifact bytes/text on stdout (CLI)
 * Shell pipes/redirections are the composition mechanism.
 *
 * Directory batching is not a CLI concern: loop outside.
 * Both adapters are generated from this table:
 *   - src/cli.ts → flags
 *   - extensions/undefined-video.ts → uvid_<path>_… tools
 */
import { Type, type TObject } from "typebox";
import {
  analyzeFrameDiff,
  analyzeLoudness,
  analyzeSilence,
  analyzeWaveform,
} from "./lib/analyze/index.ts";
import {
  generateBgm,
  generateCaptions,
  generateEdit,
  generateFrame,
  generateNormalize,
  generateOtio,
  generateRender,
  generateScene,
  generateSheet,
  generateTimeline,
  generateVideo,
} from "./lib/generate/index.ts";
import type { Ctx } from "./lib/util.ts";

export interface CommandSpec {
  path: string[];
  /** analyze | generate */
  family: "analyze" | "generate";
  summary: string;
  description?: string;
  consumes?: string[];
  produces?: string[];
  params: TObject;
  /** CLI: collect trailing non-flag args into params.paths (string[]). */
  positionals?: boolean;
  run: (params: any, ctx: Ctx) => Promise<void>;
}

const ioParams = {
  input: Type.Optional(
    Type.String({
      description: "Input file; omit to read stdin (CLI only; tools should pass a path)",
    }),
  ),
  output: Type.Optional(
    Type.String({
      description:
        "Output file for the main artifact; when set, file is written and stdout prints its absolute path " +
        "(omit → artifact on stdout; tools: JSON may go to result text, binary needs a path)",
    }),
  ),
};

export const commands: CommandSpec[] = [
  // ── analyze ───────────────────────────────────────────────────────────
  {
    path: ["analyze", "loudness"],
    family: "analyze",
    summary: "measure integrated loudness (ebur128) → JSON",
    description:
      "Analyze: ffmpeg ebur128 → one JSON object {I, LRA, peak}. " +
      "Optional half-open window [--from-ms A --to-ms B]. " +
      "CLI: `uvid analyze loudness [-i MEDIA] [-o JSON] [--from-ms 0] [--to-ms N]`.",
    consumes: ["media"],
    produces: ["analyze.loudness JSON"],
    params: Type.Object({
      ...ioParams,
      fromMs: Type.Optional(Type.Number({ description: "Window start ms (inclusive); default 0" })),
      toMs: Type.Optional(Type.Number({ description: "Window end ms (exclusive); omit = end of media" })),
    }),
    run: analyzeLoudness,
  },
  {
    path: ["analyze", "waveform"],
    family: "analyze",
    summary: "windowed RMS/peak waveform → JSON",
    description:
      "Analyze: decode mono PCM, window RMS/peak → one waveform JSON. " +
      "Optional half-open window; window times are absolute source ms. " +
      "CLI: `uvid analyze waveform [-i MEDIA] [-o JSON] [--window-ms 50] [--sample-rate 48000] [--from-ms 0] [--to-ms N]`.",
    consumes: ["media"],
    produces: ["analyze.waveform JSON"],
    params: Type.Object({
      ...ioParams,
      windowMs: Type.Optional(Type.Number({ description: "Window size ms; default 50" })),
      sampleRate: Type.Optional(Type.Number({ description: "Decode sample rate; default 48000" })),
      fromMs: Type.Optional(Type.Number({ description: "Window start ms (inclusive); default 0" })),
      toMs: Type.Optional(Type.Number({ description: "Window end ms (exclusive); omit = end of media" })),
    }),
    run: analyzeWaveform,
  },
  {
    path: ["analyze", "silence"],
    family: "analyze",
    summary: "silence ranges from waveform JSON → JSON",
    description:
      "Analyze: read analyze.waveform JSON, emit silence ranges. " +
      "CLI: `uvid analyze silence [-i WAVEFORM.json] [-o JSON] [--min-ms 300] [--threshold-db -40] [--pad-ms 0] [--from-ms 0] [--to-ms N] [--max-ranges N]`. " +
      "Pipe: `uvid analyze waveform -i a.mp4 | uvid analyze silence -o silence.json`.",
    consumes: ["analyze.waveform JSON"],
    produces: ["analyze.silence JSON"],
    params: Type.Object({
      ...ioParams,
      minMs: Type.Optional(Type.Number({ description: "Min silence duration ms; default 300" })),
      thresholdDb: Type.Optional(Type.Number({ description: "RMS dB threshold; default -40" })),
      padMs: Type.Optional(Type.Number({ description: "Expand each range by N ms on both sides; default 0" })),
      fromMs: Type.Optional(Type.Number({ description: "Only ranges overlapping from this ms" })),
      toMs: Type.Optional(Type.Number({ description: "Only ranges overlapping before this ms (exclusive)" })),
      maxRanges: Type.Optional(Type.Number({ description: "Keep at most N ranges (longest first)" })),
    }),
    run: analyzeSilence,
  },
  {
    path: ["analyze", "frame-diff"],
    family: "analyze",
    summary: "video frame change points (MAE) → JSON only",
    description:
      "Analyze: low-fps grayscale MAE change points. Does not extract stills. " +
      "Optional half-open window; points[].timeMs stay absolute. " +
      "CLI: `uvid analyze frame-diff [-i VIDEO] [-o JSON] [--from-ms 0] [--to-ms N] [--fps 5] [--width 320] [--height H] [--min-score S] [--max-points 40] [--merge-ms M]`. " +
      "Stills: call `uvid generate frame` once per timeMs.",
    consumes: ["video"],
    produces: ["analyze.frame-diff JSON"],
    params: Type.Object({
      ...ioParams,
      fps: Type.Optional(Type.Number({ description: "Sample fps; default 5" })),
      width: Type.Optional(Type.Number({ description: "Downscale width; default 320" })),
      height: Type.Optional(Type.Number({ description: "Downscale height; default width*9/16" })),
      fromMs: Type.Optional(Type.Number({ description: "Window start ms (inclusive); default 0" })),
      toMs: Type.Optional(Type.Number({ description: "Window end ms (exclusive); omit = end of media" })),
      minScore: Type.Optional(
        Type.Number({ description: "Raise detection floor (0–1); adaptive thr = max(adaptive, minScore)" }),
      ),
      maxPoints: Type.Optional(Type.Number({ description: "Max points kept (by score); default 40" })),
      mergeMs: Type.Optional(
        Type.Number({ description: "Merge points closer than this ms; default ≈ 2 sample intervals" }),
      ),
    }),
    run: analyzeFrameDiff,
  },

  // ── generate ──────────────────────────────────────────────────────────
  {
    path: ["generate", "normalize"],
    family: "generate",
    summary: "two-pass loudnorm → one media file (default audio: mp3)",
    description:
      "Generate: linear loudnorm. Default audio format is mp3 (smaller intermediates). " +
      "`-f mp3|wav|aac` forces audio-only; `-f mp4` keeps video stream-copy + aac. " +
      "Format also inferred from -o extension. Optional trim window. " +
      "CLI: `uvid generate normalize [-i IN] [-o OUT] [-f mp3] --lufs N --tp N --lra N [--bitrate 192k] [--sample-rate 48000] [--from-ms 0] [--to-ms N]`.",
    consumes: ["media (raw)"],
    produces: ["media (normalized)"],
    params: Type.Object({
      ...ioParams,
      format: Type.Optional(
        Type.String({ description: "Output format: mp3 (default) | wav | aac | mp4; also from -o ext" }),
      ),
      lufs: Type.Number({ description: "Integrated loudness target LUFS, e.g. -16" }),
      tp: Type.Number({ description: "True peak target dBTP, e.g. -1.5" }),
      lra: Type.Number({ description: "Loudness range target, e.g. 11" }),
      bitrate: Type.Optional(Type.String({ description: "Lossy audio bitrate, e.g. 192k; default 192k" })),
      sampleRate: Type.Optional(Type.Number({ description: "Output sample rate Hz; default 48000" })),
      fromMs: Type.Optional(Type.Number({ description: "Trim start ms (inclusive); default 0" })),
      toMs: Type.Optional(Type.Number({ description: "Trim end ms (exclusive); omit = end of media" })),
    }),
    run: generateNormalize,
  },
  {
    path: ["generate", "frame"],
    family: "generate",
    summary: "extract one still JPEG at atMs",
    description:
      "Generate: single frame at --at-ms. One invocation = one image. " +
      "CLI: `uvid generate frame -i VIDEO -o still.jpg --at-ms 21600 [--width 640] [--height H] [--quality 3]`. " +
      "Requires -i file path (no video stdin).",
    consumes: ["video"],
    produces: ["one JPEG"],
    params: Type.Object({
      ...ioParams,
      atMs: Type.Number({ description: "Source timeline time in milliseconds" }),
      width: Type.Optional(Type.Number({ description: "JPEG width; default 640" })),
      height: Type.Optional(Type.Number({ description: "JPEG height; omit keeps aspect" })),
      quality: Type.Optional(Type.Number({ description: "JPEG -q:v 1–31 (lower=better); default 3" })),
    }),
    run: generateFrame,
  },
  {
    path: ["generate", "timeline"],
    family: "generate",
    summary: "edit.json → timeline.json (basis=aroll | program)",
    description:
      "Compile sparse edit intent into one uvid.timeline JSON. Two products: " +
      "(1) basis=aroll — body segments + captions only; " +
      "(2) basis=program — body + intro/toc/outro media + dialog[] state sequence. " +
      "Packaging is applied here, not in generate video: --intro / --outro / --toc are explicit media paths (duration probed). " +
      "TOC: --toc-before ID,ID must pair with equal-length --toc path,path (no black placeholders). " +
      "BGM: --bgm path binds audio bed into timeline.bgm with window intro-end→outro-start (body+TOC only). " +
      "Dialog sprites: --dialog DIR binds timeline.dialogSprites (idle/talk-*/wait-on.png). " +
      "ASS look: --fg/--bg/--font/--font-size → timeline.captionsStyle (burned by generate video). " +
      "Program dialog[] schedules idle/talk-*/wait-on/hidden from caption turns (mouth word-timed; continuous speech keeps box; long mute → idle; packaging → hidden). " +
      "Does not scan cache/ or invent default packaging files. " +
      "CLI aroll: `uvid generate timeline -i edit.json -o timeline.aroll.json`. " +
      "CLI program: `uvid generate timeline -i edit.json -o timeline.program.json --intro clips/intro.mp4 --outro clips/outro.mp4 --toc-before 02,03,04 --toc clips/toc1.mp4,clips/toc2.mp4,clips/toc3.mp4 --dialog clips/dialog --bgm clips/bgm.mp3 --fg '#abb2bf' --bg '#282c34'`. " +
      "Pipe: `cat edit.json | uvid generate timeline -o timeline.json`.",
    consumes: ["edit.json"],
    produces: ["timeline.json"],
    params: Type.Object({
      ...ioParams,
      intro: Type.Optional(
        Type.String({
          description:
            "Intro media path (episode-relative or absolute). Duration/audio probed from file; no default path",
        }),
      ),
      outro: Type.Optional(
        Type.String({
          description:
            "Outro media path (episode-relative or absolute). Duration/audio probed from file; no default path",
        }),
      ),
      tocBefore: Type.Optional(
        Type.String({
          description:
            "Comma-separated source ids before which to insert TOC clips; must pair with equal-length --toc",
        }),
      ),
      toc: Type.Optional(
        Type.String({
          description:
            "Comma-separated TOC media paths (equal length with --toc-before). Duration/audio probed; required when --toc-before set",
        }),
      ),
      tocTitles: Type.Optional(
        Type.String({ description: "Optional comma-separated titles aligned with --toc-before" }),
      ),
      bgm: Type.Optional(
        Type.String({
          description:
            "BGM audio path (episode-relative or absolute). Bound into timeline.bgm with startMs/endMs = intro end → outro start; mixed by generate video",
        }),
      ),
      dialog: Type.Optional(
        Type.String({
          description:
            "Dialog sprite directory (idle/talk-closed/talk-open/wait-on.png). Bound into timeline.dialogSprites",
        }),
      ),
      fg: Type.Optional(Type.String({ description: "ASS revealed fill #RRGGBB → timeline.captionsStyle.fg" })),
      bg: Type.Optional(Type.String({ description: "ASS panel reference #RRGGBB → timeline.captionsStyle.bg" })),
      font: Type.Optional(Type.String({ description: "ASS Fontname → timeline.captionsStyle.font" })),
      fontSize: Type.Optional(Type.Number({ description: "ASS Fontsize → timeline.captionsStyle.fontSize" })),
      minAudioShardMs: Type.Optional(
        Type.Number({ description: "Discard audio shards shorter than this; default 120" }),
      ),
      fadeMs: Type.Optional(Type.Number({ description: "Default edge afade ms; default 16" })),
      highRiskGapMs: Type.Optional(
        Type.Number({ description: "Collapsed source gap ≥ this → high-risk fade; default 1000" }),
      ),
      highRiskFadeMs: Type.Optional(Type.Number({ description: "High-risk edge afade ms; default 32" })),
      nearEndSnapMs: Type.Optional(
        Type.Number({ description: "Range drop ending within this of media end snaps to end; default 500" }),
      ),
    }),
    run: generateTimeline,
  },
  {
    path: ["generate", "video"],
    family: "generate",
    summary: "timeline.json → one episode mp4 (A-roll or final program)",
    description:
      "Render one combined mp4 from timeline.json only. All product assets are already bound on the timeline: " +
      "segments (incl. packaging), dialog[], dialogSprites, bgm, captionsStyle. " +
      "basis=aroll → body A-roll. basis=program → base + dialog overlay + ASS burn-in + BGM mix. " +
      "This command accepts only render presets (quality/fps/size) — no side asset paths. " +
      "Still/markdown segments take audio from media, picture from visual. Unified yuv420p/bt709. " +
      "CLI: `uvid generate video -i timeline.program.json -o program-final.mp4 [--quality draft]`. " +
      "Boundary: generate render remains scene-dir → single media; this command assembles the episode.",
    consumes: ["timeline.json"],
    produces: ["episode.mp4"],
    params: Type.Object({
      ...ioParams,
      quality: Type.Optional(
        Type.String({ description: "draft (default) | standard | high" }),
      ),
      fps: Type.Optional(Type.Number({ description: "Output fps; default 25" })),
      width: Type.Optional(Type.Number({ description: "Output width; default 1280" })),
      height: Type.Optional(Type.Number({ description: "Output height; default 720" })),
    }),
    run: generateVideo,
  },
  {
    path: ["generate", "captions"],
    family: "generate",
    summary: "timeline.json → subtitles on program axis (srt / ass typewriter)",
    description:
      "Export subtitles from timeline.captions[] on the compiled program axis (not raw ASR). " +
      "srt = turn-level preview. ass typewriter (default when words exist) = karaoke \\k, 1 event/turn, " +
      "transparent Secondary so unrevealed glyphs do not paint. " +
      "Style knobs: --fg / --bg / --font / --font-size (defaults from everforest + themes.css --font-body). " +
      "--style plain = full line (no karaoke). " +
      "CLI: `uvid generate captions -i timeline.json -o out.ass [--fg #d3c6aa --bg #272e33 --font 'Fusion Pixel 12px M zh_hans']`.",
    consumes: ["timeline.json"],
    produces: ["captions.srt|ass"],
    params: Type.Object({
      ...ioParams,
      format: Type.Optional(Type.String({ description: "srt (default) | ass; also inferred from -o extension" })),
      style: Type.Optional(
        Type.String({
          description:
            "ASS only: typewriter (default; karaoke \\k) | plain. Aliases: karaoke, rpg → typewriter",
        }),
      ),
      fg: Type.Optional(
        Type.String({ description: "Revealed text fill #RRGGBB; default everforest --fg #d3c6aa" }),
      ),
      bg: Type.Optional(
        Type.String({
          description:
            "Panel reference #RRGGBB; default everforest --bg #272e33 (alignment/docs; typewriter unrevealed is transparent)",
        }),
      ),
      font: Type.Optional(
        Type.String({
          description:
            'ASS Fontname; default themes.css --font-body "Fusion Pixel 12px M zh_hans" (must be installed)',
        }),
      ),
      fontSize: Type.Optional(
        Type.Number({ description: "ASS Fontsize at 1280x720; default 36 typewriter / 42 plain" }),
      ),
    }),
    run: generateCaptions,
  },
  {
    path: ["generate", "otio"],
    family: "generate",
    summary: "timeline.json → one OpenTimelineIO JSON (.otio)",
    description:
      "NLE interchange export from timeline.json only (same assets as generate video). " +
      "Tracks: V1 Program, V2_DIALOG (dialog[] needles; hidden=gap), A1_VOICE, A3_BGM (timeline.bgm windowed intro-end→outro-start). " +
      "Captions become markers on Program with captionsStyle metadata. " +
      "CLI: `uvid generate otio -i timeline.program.json -o out.otio [--fps 25] [--name episode]`.",
    consumes: ["timeline.json"],
    produces: ["timeline.otio"],
    params: Type.Object({
      ...ioParams,
      name: Type.Optional(Type.String({ description: "Timeline name inside OTIO" })),
      fps: Type.Optional(Type.Number({ description: "OTIO rate; default 25" })),
    }),
    run: generateOtio,
  },
  {
    path: ["generate", "edit"],
    family: "generate",
    summary: "ASR JSON(s) → upsert source(s) into edit.json (empty actions)",
    description:
      "Generate: read ASR JSON path(s), assign stable turn/word ids, upsert into edit.json (-o). " +
      "Parallel multi-args must be equal length: -i / --id / --type / --media (optional --visual). " +
      "Comma-separated or repeated flags. Visual slot '-' means none. " +
      "No script.md parse, no cache layout scan. Does not invent cuts. " +
      "Re-run preserves each source's actions and other sources. Schema: skills/undefined-video/schemas/edit.schema.json. " +
      "CLI: `uvid generate edit -i a.json,b.json -o edit.json --id 01,02 --type audio,video --media a.mp3,b.mp4`. " +
      "Or single: `… -i a.json --id 01 --type audio --media a.mp3 --visual a.png`.",
    consumes: ["asr.json (+ explicit media paths)"],
    produces: ["edit.json (upsert source(s))"],
    params: Type.Object({
      input: Type.Optional(
        Type.Array(Type.String(), {
          description: "ASR JSON path(s); equal length with --id/--type/--media (comma or repeated)",
        }),
      ),
      output: Type.Optional(
        Type.String({
          description:
            "edit.json path; when set, file is written and stdout prints absolute path (omit → JSON on stdout)",
        }),
      ),
      id: Type.Array(Type.String(), {
        description: "Source id(s), e.g. 01 or 01,02",
      }),
      type: Type.Array(Type.String(), {
        description: "audio|video per source; equal length with --id",
      }),
      media: Type.Array(Type.String(), {
        description: "Media path(s) stored on sources; equal length with --id",
      }),
      visual: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional still path(s); equal length if set; use - for none",
        }),
      ),
      script: Type.Optional(
        Type.String({ description: "Optional script path metadata when creating a new edit file" }),
      ),
      title: Type.Optional(
        Type.String({ description: "Optional title when creating a new edit file" }),
      ),
      status: Type.Optional(
        Type.String({
          description:
            "Initial status for new files: subtitle-draft (default) | audio-reviewed | video-reviewed | ready",
        }),
      ),
    }),
    run: generateEdit,
  },
  {
    path: ["generate", "bgm"],
    family: "generate",
    summary: "bgm.mml → one chiptune audio file (default mp3)",
    description:
      "Generate: NES-style MML → FamiStudio → loudnorm bed. " +
      "Pass --duration SEC when the bed must cover a known window (caller computes length). " +
      "CLI: `uvid generate bgm [-i bgm.mml] [-o bgm.mp3] [--duration SEC] [-f mp3] [--sample-rate 48000] [--bitrate 192]`.",
    consumes: ["bgm.mml"],
    produces: ["bgm audio (mp3|wav|aac)"],
    params: Type.Object({
      ...ioParams,
      duration: Type.Optional(
        Type.Number({ description: "Export length seconds (FamiStudio); omit = full song loop length" }),
      ),
      sampleRate: Type.Optional(Type.Number({ description: "44100 or 48000; default 48000" })),
      bitrate: Type.Optional(Type.Number({ description: "FamiStudio/final kbps; default 192" })),
      format: Type.Optional(
        Type.String({ description: "Output format: mp3 (default) | wav | aac; also from -o ext" }),
      ),
      lufs: Type.Optional(Type.Number({ description: "Bed loudness LUFS; default -42" })),
      tp: Type.Optional(Type.Number({ description: "True peak dBTP; default -9" })),
      lra: Type.Optional(Type.Number({ description: "Loudness range; default 11" })),
    }),
    run: generateBgm,
  },
  {
    path: ["generate", "scene"],
    family: "generate",
    summary: "one HyperFrames scene project dir (intro|outro|toc|markdown|dialog)",
    description:
      "Generate: package templates → one renderable HyperFrames scene directory. " +
      "Types: intro, outro, toc, markdown, dialog (stock packaging only). " +
      "Freeform AI HyperFrames: write index.html yourself under a scene dir, then " +
      "`uvid generate render` — do not use generate scene. " +
      "Main product is a directory (-o required); stdout prints that absolute path. " +
      "Multiple scenes = multiple invocations (shell loop), not one multi-dir command. " +
      "TOC short form: `uvid generate scene --type toc --theme onedark --chapters 'a,b,c' --current 1 -o scenes/toc-ch2`. " +
      "CLI: `uvid generate scene --type intro --theme onedark -o scenes/intro`.",
    consumes: ["markdown (type=markdown)", "package templates/assets"],
    produces: ["one scene project directory"],
    params: Type.Object({
      type: Type.String({
        description: "Scene type: intro | outro | toc | markdown | dialog",
      }),
      output: Type.String({ description: "Output scene project directory (required)" }),
      theme: Type.Optional(Type.String({ description: "Theme name; required for current types" })),
      input: Type.Optional(
        Type.String({ description: "Markdown file; required for type=markdown (or stdin)" }),
      ),
      speakerSprite: Type.Optional(
        Type.String({
          description:
            "Speaker sprite .json path for type=dialog. Default: template assets/speaker-sprite.json",
        }),
      ),
      fps: Type.Optional(Type.Number({ description: "FPS for type=dialog; default 25" })),
      watermark: Type.Optional(Type.String({ description: "Optional watermark text" })),
      id: Type.Optional(Type.String({ description: "Composition id; toc defaults to basename(-o)" })),
      duration: Type.Optional(
        Type.Number({
          description:
            "Seconds for type=markdown only (default 4). TOC/intro/outro length is owned by the HyperFrames template",
        }),
      ),
      chapters: Type.Optional(
        Type.String({
          description: "TOC chapter titles, comma-separated (primary). Exclusive with --chapters-file",
        }),
      ),
      chaptersFile: Type.Optional(
        Type.String({ description: "TOC chapters JSON array file; exclusive with --chapters" }),
      ),
      current: Type.Optional(
        Type.Number({ description: "TOC 0-based current chapter index (required for type=toc)" }),
      ),
      previous: Type.Optional(
        Type.Number({
          description: "TOC 0-based previous index for cursor travel; default current-1 (or current if 0)",
        }),
      ),
    }),
    run: generateScene,
  },
  {
    path: ["generate", "render"],
    family: "generate",
    summary: "HyperFrames scene dir → mp4/webm/mov/gif/png/png-sequence/sprite",
    description:
      "Generate: scene project → one media product. " +
      "Video/gif/png-sequence use `hyperframes render`. " +
      "`-f png` (or `-o *.png`) uses `hyperframes snapshot` for one still — the fast path for static cards. " +
      "`-f sprite` (dialog scene only) writes one directory of 4 named RGBA PNGs: " +
      "idle, talk-closed, talk-open, wait-on (talk-closed also = wait blink-off). " +
      "Default format mp4. Format from `-f` / `--format`, or from `-o` extension. " +
      "CLI: `uvid generate render -i scenes/intro -o clips/intro.mp4 [--fps 25] [--quality high]`. " +
      "Still: `uvid generate render -i scenes/md -o still.png -f png [--at-ms 0]`. " +
      "Dialog set: `uvid generate render -i scenes/dialog -o clips/dialog -f sprite`. " +
      "PNG sequence: `… -f png-sequence -o frames/dir`.",
    consumes: ["HyperFrames scene directory"],
    produces: ["one video/gif/png file, PNG sequence directory, or sprite directory"],
    params: Type.Object({
      input: Type.String({ description: "Scene project directory (with index.html)" }),
      output: Type.String({
        description: "Output file (mp4/webm/mov/gif/png) or directory (png-sequence | sprite)",
      }),
      format: Type.Optional(
        Type.String({
          description: "mp4 (default) | webm | mov | gif | png | png-sequence | sprite; also from -o ext",
        }),
      ),
      fps: Type.Optional(Type.Number({ description: "Render fps; default 25 (video formats)" })),
      quality: Type.Optional(
        Type.String({ description: "hyperframes quality: draft|standard|high; default high (video formats)" }),
      ),
      workers: Type.Optional(Type.Number({ description: "Parallel workers; default 1 (video formats)" })),
      atMs: Type.Optional(
        Type.Number({ description: "Still capture time ms for format=png; default 0" }),
      ),
    }),
    run: generateRender,
  },
  {
    path: ["generate", "sheet"],
    family: "generate",
    summary: "images → one contact-sheet image (native size unless cell size set)",
    description:
      "Generate: ImageMagick montage of stills with per-cell labels (title from filename). " +
      "Does not open a viewer. Cells keep native pixels unless --cell-width/--cell-height. " +
      "CLI: `uvid generate sheet [FILE…] [-o sheet.jpg] [--list paths.txt] [--tile 4x2]`. " +
      "Use mpv / imv to view the contact sheet.",
    consumes: ["images"],
    produces: ["one contact-sheet image"],
    positionals: true,
    params: Type.Object({
      input: Type.Optional(
        Type.String({ description: "Single image (optional if positionals / --list)" }),
      ),
      output: Type.Optional(
        Type.String({ description: "Output image file; omit → stdout (binary; not a TTY)" }),
      ),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Additional images (CLI trailing args; tools may pass an array)",
        }),
      ),
      list: Type.Optional(
        Type.String({ description: "Text file: one image path per line (# comments ok)" }),
      ),
      tile: Type.Optional(
        Type.String({ description: "Montage grid e.g. 4x2 or 3x; default auto from count" }),
      ),
      cellWidth: Type.Optional(
        Type.Number({
          description: "Max cell width px; omit with cellHeight = no resize (native)",
        }),
      ),
      cellHeight: Type.Optional(
        Type.Number({
          description: "Max cell height px; omit with cellWidth = no resize (native)",
        }),
      ),
      gap: Type.Optional(Type.Number({ description: "Cell gap px; default 12" })),
      labelPad: Type.Optional(
        Type.Number({ description: "Extra bottom pad for labels px; default 28" }),
      ),
      title: Type.Optional(Type.String({ description: "Overall sheet title (montage -title)" })),
      font: Type.Optional(Type.String({ description: "Label font; default FreeSans" })),
      pointSize: Type.Optional(Type.Number({ description: "Label point size; default 16" })),
    }),
    run: generateSheet,
  },

];

