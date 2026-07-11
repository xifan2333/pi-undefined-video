/**
 * uvid command spec — the single source of truth.
 *
 * Commands are grouped by production stage (prep / draft / finish / deliver).
 * Style: `uvid <stage> <action> [flags]`. Prefer two-level paths.
 *
 * Both adapters are generated from this table:
 *   - src/cli.ts turns properties into --kebab-case flags (aliases: input→-i, output→-o)
 *   - extensions/undefined-video.ts registers each entry as a pi tool `uvid_<path>_…`
 *
 * Adding a parameter = editing exactly one schema here.
 */
import { Type, type TObject } from "typebox";
import type { Ctx } from "./lib/util.ts";
import { audioCreateLoudness, audioGetLoudness, audioGetWaveform } from "./lib/prep.ts";
import { audioCreateBgm } from "./lib/bgm.ts";
import { audioGetCutpoints } from "./lib/cutpoints.ts";
import { audioCreatePremix, audioGetSplices } from "./lib/premix.ts";
import { draftEvidence, draftInit, draftSubtitles, draftSurvey, draftValidate } from "./lib/draft.ts";
import { draftCheck } from "./lib/check.ts";
import { timelineCreateMain, timelineCreateOtio, timelinePlan } from "./lib/timeline.ts";
import { subtitleCreateAss } from "./lib/subtitle.ts";
import { imageCreateDialog, sceneCreate } from "./lib/scene.ts";
import { videoRenderFinal } from "./lib/deliver.ts";

export interface CommandSpec {
  /** CLI command path, e.g. ["draft", "premix"]. */
  path: string[];
  summary: string;
  /** Long description for the pi tool (falls back to summary). */
  description?: string;
  /**
   * Artifact kinds this command reads / writes. Together these declare the
   * pipeline: every command is a filter between artifacts on disk, and
   * `uvid flow` prints the full topology. Kinds are contracts (draft.json
   * schema, asr json shape, …), never concrete paths — paths are the
   * caller's policy.
   */
  consumes?: string[];
  produces?: string[];
  params: TObject;
  run: (params: any, ctx: Ctx) => Promise<void>;
}

export const commands: CommandSpec[] = [
  // ── prep ──────────────────────────────────────────────────────────────
  {
    path: ["prep", "loudness"],
    summary: "measure integrated loudness of one audio/video source",
    description:
      "Prep stage: measure integrated loudness (I/LRA/Peak via ebur128). " +
      "CLI: `uvid prep loudness -i INPUT`.",
    consumes: ["media"],
    produces: ["loudness stats (log)"],
    params: Type.Object({
      input: Type.String({ description: "Input audio/video file" }),
    }),
    run: audioGetLoudness,
  },
  {
    path: ["prep", "normalize"],
    summary: "loudness-normalize one source into clips/ (prep)",
    description:
      "Prep stage: create a loudness-normalized copy (two-pass linear loudnorm). " +
      "Voice targets for this workflow are typically I=-16 LUFS, TP=-1.5 dBTP, LRA=11. " +
      "CLI: `uvid prep normalize -i INPUT -o OUTPUT --lufs N --tp N --lra N`.",
    consumes: ["media (raw)"],
    produces: ["media (normalized)"],
    params: Type.Object({
      input: Type.String({ description: "Input audio/video file" }),
      output: Type.String({ description: "Output audio/video file" }),
      lufs: Type.Number({ description: "Integrated loudness target LUFS, e.g. -16" }),
      tp: Type.Number({ description: "True peak target dBTP, e.g. -1.5" }),
      lra: Type.Number({ description: "Loudness range target, e.g. 11" }),
    }),
    run: audioCreateLoudness,
  },
  {
    path: ["prep", "waveform"],
    summary: "windowed RMS/peak waveform report for one source",
    description:
      "Prep/analysis helper: windowed RMS/peak waveform JSON. Prefer -o (inline can be huge). " +
      "CLI: `uvid prep waveform -i INPUT [-o OUTPUT] [--window-ms 50] [--sample-rate 48000]`.",
    consumes: ["media"],
    produces: ["waveform.json"],
    params: Type.Object({
      input: Type.String({ description: "Input audio/video file" }),
      output: Type.Optional(Type.String({ description: "Output JSON file; strongly recommended" })),
      windowMs: Type.Optional(Type.Number({ description: "Analysis window size in milliseconds; default 50" })),
      sampleRate: Type.Optional(Type.Number({ description: "Decode sample rate; default 48000" })),
    }),
    run: audioGetWaveform,
  },

  // ── draft ─────────────────────────────────────────────────────────────
  {
    path: ["draft", "survey"],
    summary: "pre-draft reports from script+clips+asr (no draft.json needed)",
    description:
      "Before writing draft.json: parse script media list, load ASR, measure silence/energy per sentence, " +
      "and for kind=video extract frames at speech end / +0.5s / +1s / +2s into original-size contact sheets. " +
      "AI uses these reports to write ranges (video out follows picture, not only speech end). " +
      "CLI: `uvid draft survey --script script.md --clips-dir clips --asr-dir .uvid-cache/asr -o .uvid-cache/draft-survey`.",
    consumes: ["script.md", "media (normalized)", "asr.json"],
    produces: ["survey reports", "survey contact sheets"],
    params: Type.Object({
      script: Type.String({ description: "script.md path" }),
      clipsDir: Type.String({ description: "Normalized clips directory" }),
      asrDir: Type.String({ description: "ASR json directory" }),
      output: Type.String({ description: "Output survey directory" }),
      source: Type.Optional(Type.String({ description: "Only one source id" })),
    }),
    run: draftSurvey,
  },
  {
    path: ["draft", "init"],
    summary: "generate draft.json skeleton from script+clips+asr (decisions left empty)",
    description:
      "Draft decide helper: build the draft.json boilerplate so the editor only writes decisions. " +
      "Fills sources[] (path/asr/kind/durationMs) and entries[] verbatim from ASR; ranges[] stay empty. " +
      "Refuses to overwrite without --force. " +
      "CLI: `uvid draft init --script script.md --clips-dir clips --asr-dir .uvid-cache/asr -o draft.json`.",
    consumes: ["script.md", "media (normalized)", "asr.json"],
    produces: ["draft.json (skeleton, decisions empty)"],
    params: Type.Object({
      script: Type.String({ description: "script.md path" }),
      clipsDir: Type.String({ description: "Normalized clips directory" }),
      asrDir: Type.String({ description: "ASR json directory" }),
      output: Type.String({ description: "Output draft.json path" }),
      force: Type.Optional(Type.Boolean({ description: "Overwrite existing draft.json" })),
    }),
    run: draftInit,
  },
  {
    path: ["draft", "evidence"],
    summary: "visual continuity evidence for kind=video ranges/splices",
    description:
      "Draft evidence: scene-detect around range outs, extract original-size frames, build contact sheets. " +
      "Does not modify draft.json. CLI: `uvid draft evidence --draft draft.json -o .uvid-cache/draft-evidence`.",
    consumes: ["draft.json (with ranges)", "media (normalized)"],
    produces: ["evidence reports", "evidence contact sheets"],
    params: Type.Object({
      draft: Type.String({ description: "draft.json path" }),
      output: Type.String({ description: "Output evidence directory" }),
      source: Type.Optional(Type.String({ description: "Only analyze one source id; default: all kind=video" })),
      preMs: Type.Optional(Type.Number({ description: "Look back before candidate out in ms; default 500" })),
      postMs: Type.Optional(Type.Number({ description: "Look ahead after candidate out in ms; default 4000" })),
      settleMs: Type.Optional(Type.Number({ description: "Settle buffer after last visual change in ms; default 400" })),
      sceneThreshold: Type.Optional(Type.Number({ description: "ffmpeg scene threshold; default 0.0001" })),
      contactSheets: Type.Optional(Type.Boolean({ description: "Generate original-size montage contact sheets; default true" })),
    }),
    run: draftEvidence,
  },
  {
    path: ["draft", "cutpoints"],
    summary: "audio cut-point evidence for draft ranges/ASR boundaries",
    description:
      "Draft evidence: energy/silence/zero-crossing reports around draft boundaries. " +
      "Writes waveform-<id>.json. CLI: `uvid draft cutpoints --draft FILE (--source ID | --all) -o DIR`.",
    consumes: ["draft.json (with ranges)", "media (normalized)"],
    produces: ["cutpoint reports"],
    params: Type.Object({
      draft: Type.String({ description: "draft.json path" }),
      output: Type.String({ description: "Output directory for waveform-<id>.json reports" }),
      source: Type.Optional(Type.String({ description: "Analyze one source id, e.g. 01" })),
      all: Type.Optional(Type.Boolean({ description: "Analyze all sources" })),
    }),
    run: audioGetCutpoints,
  },
  {
    path: ["draft", "premix"],
    summary: "render A-roll premix WAV for one source from draft ranges",
    description:
      "Draft apply: trim/join ranges with declared smoothing; mono 48kHz WAV. " +
      "CLI: `uvid draft premix --draft FILE --source ID -o clips/src-ID.wav`.",
    consumes: ["draft.json (with ranges)", "media (normalized)"],
    produces: ["premix.wav"],
    params: Type.Object({
      draft: Type.String({ description: "draft.json path" }),
      source: Type.String({ description: "Source id, e.g. 01" }),
      output: Type.String({ description: "Output WAV file" }),
    }),
    run: audioCreatePremix,
  },
  {
    path: ["draft", "splices"],
    summary: "post-premix splice hardness analysis",
    description:
      "Draft apply check: hardnessScore on premix joins. " +
      "CLI: `uvid draft splices -i PREMIX.wav --draft FILE --source ID [-o REPORT.json]`.",
    consumes: ["premix.wav", "draft.json (with ranges)"],
    produces: ["splices.json"],
    params: Type.Object({
      input: Type.String({ description: "Rendered premix WAV" }),
      draft: Type.String({ description: "draft.json path" }),
      source: Type.String({ description: "Source id, e.g. 01" }),
      output: Type.Optional(Type.String({ description: "Output JSON report; inline when omitted" })),
    }),
    run: audioGetSplices,
  },
  {
    path: ["draft", "subtitles"],
    summary: "derive sources[].subtitles from kept entries + ranges",
    description:
      "Draft apply: write source-local subtitles into draft.json. " +
      "CLI: `uvid draft subtitles -i draft.json [--source ID] [--dry-run]`.",
    consumes: ["draft.json (with ranges)"],
    produces: ["draft.json (subtitles derived)"],
    params: Type.Object({
      input: Type.String({ description: "draft.json path" }),
      source: Type.Optional(Type.String({ description: "One source id only; default: all" })),
      dryRun: Type.Optional(Type.Boolean({ description: "Report without writing; CLI: --dry-run" })),
    }),
    run: draftSubtitles,
  },
  {
    path: ["draft", "validate"],
    summary: "validate draft.json structure and semantics",
    description:
      "Draft gate: schema/semantic checks; --strict treats warnings as failures. " +
      "CLI: `uvid draft validate -i draft.json [--no-check-files] [--strict]`.",
    consumes: ["draft.json"],
    produces: ["findings (log)"],
    params: Type.Object({
      input: Type.String({ description: "draft.json path" }),
      checkFiles: Type.Optional(
        Type.Boolean({
          description: "Require sources[].path and sources[].asr on disk; CLI: --no-check-files to skip",
        }),
      ),
      strict: Type.Optional(Type.Boolean({ description: "Treat warnings as failures; CLI: --strict" })),
    }),
    run: draftValidate,
  },
  {
    path: ["draft", "check"],
    summary: "one-shot apply gate: normalize + validate + premix + splices + subtitles",
    description:
      "Draft apply in one call: auto-fill derived range fields (durationMs/sourceLocal*), strict-validate, " +
      "premix every targeted source to <voiceDir>/src-NN.wav, analyze splice hardness, derive subtitles, and write " +
      "one summary.json with an actionNeeded list. Fails when anything needs attention. " +
      "Use --source NN for incremental re-check after a fix; --evidence adds video contact sheets. " +
      "CLI: `uvid draft check --draft draft.json --voice-dir clips -o .uvid-cache/draft-check [--source ID] [--evidence]`.",
    consumes: ["draft.json (with decisions)", "media (normalized)"],
    produces: ["premix.wav", "splices.json", "draft.json (subtitles derived)", "check summary.json"],
    params: Type.Object({
      draft: Type.String({ description: "draft.json path" }),
      output: Type.String({ description: "Output directory for summary.json and splice reports" }),
      voiceDir: Type.String({ description: "Directory to write premix WAVs as src-<id>.wav" }),
      source: Type.Optional(Type.String({ description: "Re-check one source id only" })),
      evidence: Type.Optional(Type.Boolean({ description: "Also run visual evidence for kind=video sources; slower" })),
      hardThreshold: Type.Optional(Type.Number({ description: "hardnessScore needing action; default 15" })),
    }),
    run: draftCheck,
  },

  // ── finish ────────────────────────────────────────────────────────────
  {
    path: ["finish", "plan"],
    summary: "list TOC/scene assets finish timeline will require (from script.md)",
    description:
      "Finish dry-run: parse script.md and print the exact scene order, TOC ids, and " +
      "required clip/voice/still filenames before you create or render anything. " +
      "TOC id = toc-{chapterIndex} where chapterIndex is 1-based order of media-bearing " +
      "--- blocks with an H2 (not H3; not free-form names). " +
      "Optional clipsDir/voiceDir/scenesDir report which files already exist. " +
      "CLI: `uvid finish plan --script script.md [-o plan.json] [--clips-dir DIR]`. " +
      "Call this before `finish scene` for toc / before `finish timeline`.",
    consumes: ["script.md"],
    produces: ["finish.plan.json (or log)"],
    params: Type.Object({
      script: Type.String({ description: "script.md path" }),
      output: Type.Optional(Type.String({ description: "Write plan JSON path; omit to print" })),
      clipsDir: Type.Optional(Type.String({ description: "Check existence of intro/toc/outro mp4" })),
      voiceDir: Type.Optional(Type.String({ description: "Check existence of src-NN.wav" })),
      scenesDir: Type.Optional(Type.String({ description: "Check existence of screen-NN-01.png; default clipsDir" })),
      draft: Type.Optional(Type.String({ description: "Reserved; draft path for future cross-checks" })),
    }),
    run: timelinePlan,
  },
  {
    path: ["finish", "scene"],
    summary: "create a HyperFrames scene project (intro/toc/markdown/outro/dialog)",
    description:
      "Finish: create renderable scene dir from templates. " +
      "CLI: `uvid finish scene --type TYPE -o DIR [flags]`.",
    consumes: ["markdown (type=markdown)", "package templates/assets"],
    produces: ["scene project dir (renderable)"],
    params: Type.Object({
      type: Type.String({ description: "Scene type: dialog, intro, outro, toc, or markdown" }),
      output: Type.String({ description: "Output scene/project directory" }),
      theme: Type.Optional(Type.String({ description: "Theme name; required for current types" })),
      input: Type.Optional(Type.String({ description: "Markdown path or '-' ; required for type=markdown" })),
      avatar: Type.Optional(Type.String({ description: "Avatar image; required for type=outro" })),
      speakerSprite: Type.Optional(Type.String({ description: "Speaker sprite JS; required for type=dialog" })),
      fps: Type.Optional(Type.Number({ description: "FPS for type=dialog; default 25" })),
      watermark: Type.Optional(Type.String({ description: "Optional watermark text" })),
      id: Type.Optional(Type.String({ description: "Composition id; required for type=toc" })),
      duration: Type.Optional(Type.Number({ description: "Seconds; required for type=toc" })),
      chaptersJson: Type.Optional(Type.String({ description: "JSON array of chapter titles for toc" })),
      chaptersFile: Type.Optional(Type.String({ description: "Path to JSON chapter titles for toc" })),
      currentIndex: Type.Optional(Type.Number({ description: "0-based current chapter index for toc" })),
      previousIndex: Type.Optional(Type.Number({ description: "0-based previous chapter index for toc" })),
    }),
    run: sceneCreate,
  },
  {
    path: ["finish", "dialog"],
    summary: "render four RPG dialog-box state PNGs",
    description:
      "Finish: rpg-open/closed × arrow/noarrow PNGs. " +
      "CLI: `uvid finish dialog -o DIR --theme THEME --speaker-sprite FILE [--fps 25]`.",
    consumes: ["speaker sprite js", "package templates"],
    produces: ["rpg dialog PNGs ×4"],
    params: Type.Object({
      output: Type.String({ description: "Output directory for the four PNGs" }),
      theme: Type.String({ description: "Theme name, e.g. onedark" }),
      speakerSprite: Type.String({ description: "Speaker sprite data JS file" }),
      fps: Type.Optional(Type.Number({ description: "Frames per second; default 25" })),
    }),
    run: imageCreateDialog,
  },
  {
    path: ["finish", "timeline"],
    summary: "create main timeline.json from script + draft + assets",
    description:
      "Finish: single time base from script + draft + rendered assets. " +
      "Expects clips/intro.mp4, clips/toc-NN.mp4 (one per H2 media chapter; NN = chapter index), " +
      "clips/outro.mp4, and voiceDir/src-NN.wav. Missing clips fail with the full expected list. " +
      "Prefer `uvid finish plan` first to learn TOC ids. " +
      "CLI: `uvid finish timeline --script FILE --draft FILE --clips-dir DIR --scenes-dir DIR --voice-dir DIR -o FILE`.",
    consumes: ["script.md", "draft.json (locked)", "scene clips", "scene stills", "premix.wav", "bgm.mp3 (optional)"],
    produces: ["timeline.json"],
    params: Type.Object({
      script: Type.String({ description: "script.md path" }),
      draft: Type.String({ description: "draft.json path" }),
      clipsDir: Type.String({ description: "Dir with intro/toc/outro mp4 etc." }),
      scenesDir: Type.String({ description: "Dir with screen-NN-01.png" }),
      voiceDir: Type.String({ description: "Dir with src-NN.wav" }),
      output: Type.String({ description: "Output timeline JSON" }),
      introSfx: Type.Optional(Type.String({ description: "Optional intro SFX" })),
      introSfxOffset: Type.Optional(Type.Number({ description: "Intro SFX offset seconds" })),
      tocSfx: Type.Optional(Type.String({ description: "Optional TOC SFX" })),
      outroSfx: Type.Optional(Type.String({ description: "Optional outro SFX" })),
      bgm: Type.Optional(Type.String({ description: "Optional BGM file" })),
      dialogOpenArrow: Type.Optional(Type.String({ description: "RPG open+arrow PNG" })),
      dialogClosedArrow: Type.Optional(Type.String({ description: "RPG closed+arrow PNG" })),
      dialogOpenNoarrow: Type.Optional(Type.String({ description: "RPG open+noarrow PNG" })),
      dialogClosedNoarrow: Type.Optional(Type.String({ description: "RPG closed+noarrow PNG" })),
    }),
    run: timelineCreateMain,
  },
  {
    path: ["finish", "subtitle"],
    summary: "create typewriter ASS from timeline + draft",
    description:
      "Finish: RPG-style ASS. " +
      "CLI: `uvid finish subtitle -i TIMELINE -o ASS --font NAME --font-size N --color HEX --outline-color HEX --pos X,Y`.",
    consumes: ["timeline.json"],
    produces: ["subtitles.ass"],
    params: Type.Object({
      input: Type.String({ description: "timeline.json path" }),
      output: Type.String({ description: "Output ASS path" }),
      font: Type.String({ description: "Font name" }),
      fontSize: Type.Number({ description: "Font size" }),
      color: Type.String({ description: "ASS primary colour" }),
      outlineColor: Type.String({ description: "ASS outline colour" }),
      pos: Type.String({ description: "ASS position x,y" }),
      backColor: Type.Optional(Type.String({ description: "ASS back colour; default &H80000000" })),
      bold: Type.Optional(Type.Boolean({ description: "Bold; default true" })),
      outline: Type.Optional(Type.Number({ description: "Outline px; default 2" })),
      shadow: Type.Optional(Type.Number({ description: "Shadow px; default 2" })),
    }),
    run: subtitleCreateAss,
  },
  {
    path: ["finish", "bgm"],
    summary: "create fixed-loudness chiptune BGM from MML",
    description:
      "Finish: MML → FamiStudio → MP3 at I=-42 LUFS, TP=-9, LRA=11. " +
      "CLI: `uvid finish bgm -i bgm.mml -o clips/bgm.mp3 [--duration SEC]`.",
    consumes: ["bgm.mml"],
    produces: ["bgm.mp3"],
    params: Type.Object({
      input: Type.String({ description: "Input MML file" }),
      output: Type.String({ description: "Output MP3" }),
      duration: Type.Optional(Type.Number({ description: "Export duration seconds" })),
      rate: Type.Optional(Type.Number({ description: "Sample rate 44100 or 48000; default 48000" })),
      bitrate: Type.Optional(Type.Number({ description: "MP3 kbps; default 192" })),
      textOutput: Type.Optional(Type.String({ description: "Optional FamiStudio text path" })),
    }),
    run: audioCreateBgm,
  },

  // ── deliver ───────────────────────────────────────────────────────────
  {
    path: ["deliver", "otio"],
    summary: "export OpenTimelineIO from timeline.json",
    description:
      "Deliver: OTIO for Kdenlive/OTIO tools. CLI: `uvid deliver otio -i timeline.json -o timeline.otio`.",
    consumes: ["timeline.json"],
    produces: ["timeline.otio"],
    params: Type.Object({
      input: Type.String({ description: "Input timeline JSON" }),
      output: Type.String({ description: "Output OTIO file" }),
    }),
    run: timelineCreateOtio,
  },
  {
    path: ["deliver", "render"],
    summary: "render final MP4 from timeline.json",
    description:
      "Deliver: V1 + dialog overlay + audio mix + optional ASS burn-in. " +
      "CLI: `uvid deliver render -i timeline.json -o final.mp4 [--subtitles subtitles.ass]`.",
    consumes: ["timeline.json", "subtitles.ass (optional)"],
    produces: ["final.mp4"],
    params: Type.Object({
      input: Type.String({ description: "timeline.json path" }),
      output: Type.String({ description: "Output MP4" }),
      subtitles: Type.Optional(Type.String({ description: "Optional ASS to burn in" })),
      workDir: Type.Optional(Type.String({ description: "Intermediate work directory" })),
      width: Type.Optional(Type.Number({ description: "Width; default 1280" })),
      height: Type.Optional(Type.Number({ description: "Height; default 720" })),
      crf: Type.Optional(Type.Number({ description: "x264 CRF; default 18" })),
      preset: Type.Optional(Type.String({ description: "x264 preset; default veryfast" })),
      audioBitrate: Type.Optional(Type.String({ description: "AAC bitrate; default 192k" })),
      keepWork: Type.Optional(Type.Boolean({ description: "Keep intermediates; default false" })),
    }),
    run: videoRenderFinal,
  },
];

// `uvid flow` — the pipeline describes itself from the command table above, so the
// topology can never drift from the implementation and needs no external docs.
commands.push({
  path: ["flow"],
  summary: "print the artifact pipeline (what each command consumes/produces)",
  description:
    "Self-description: every uvid command is a filter between artifacts on disk. " +
    "This prints the full topology grouped by stage, including where human/LLM " +
    "decisions sit between filters. CLI: `uvid flow`.",
  params: Type.Object({}),
  run: async (_p, ctx) => {
    ctx.log("uvid pipeline — every command is a filter: consumes → produces");
    ctx.log("");
    const stages: Array<[string, string | null]> = [
      ["prep", null],
      ["draft", "editor writes decisions into draft.json between `init` and `check` (word cuts, ranges in/out, smoothing)"],
      ["finish", "reviewer locks draft.json before finish (listen to premixes, inspect evidence)"],
      ["deliver", null],
    ];
    for (const [stage, note] of stages) {
      if (note) ctx.log(`── human/LLM filter: ${note}`);
      ctx.log(`${stage}`);
      for (const cmd of commands.filter((c) => c.path[0] === stage)) {
        const name = cmd.path.join(" ").padEnd(18);
        ctx.log(`  ${name} ${(cmd.consumes ?? []).join(" + ")} → ${(cmd.produces ?? []).join(", ")}`);
      }
      ctx.log("");
    }
    ctx.log("asr is an external filter: media (normalized) → asr.json (word-level; e.g. transcribe_media)");
    ctx.log("artifact contracts: draft.json = schemas/draft.schema.json; asr.json = [{text,startMs,endMs,words:[{text,startMs,endMs}]}]");
  },
});
