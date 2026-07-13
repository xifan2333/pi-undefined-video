/**
 * uvid generate captions — timeline.json → one subtitle file on that program axis.
 *
 * Single-stream: -i timeline.json → -o out.srt|ass.
 * Not ASR export. Times come only from timeline.captions[].
 *
 * Formats:
 *   srt  — turn-level preview (full line at cue start)
 *   ass  — RPG typewriter by default when captions[].words exist
 *
 * Typewriter default (karaoke reveal):
 *   One Dialogue line per cue + \\k from words.
 *   SecondaryColour fully transparent + Outline width 0 → unrevealed glyphs
 *   are absent (true RPG typewriter, not dim karaoke / bg camouflage).
 *   File stays clean: 1 event per turn, not 1 per word.
 *
 * Fallback style:
 *   plain — full line at cue start (no karaoke)
 */
import fs from "node:fs";
import path from "node:path";
import { emitWrittenPath, resolveInput, resolveOutput } from "../io.ts";
import { type Ctx, ensureDir, fail, rel } from "../util.ts";
import { DIALOG_WAIT_TAIL_MS } from "./timeline.ts";

export interface GenerateCaptionsParams {
  input?: string;
  output?: string;
  /** srt (default) | ass */
  format?: string;
  /**
   * ASS only:
   *   typewriter (default when words) = karaoke \\k, transparent secondary
   *   plain = full line
   * Aliases: karaoke|rpg → typewriter
   */
  style?: string;
  /** Revealed text fill #RRGGBB. Default everforest --fg #d3c6aa. */
  fg?: string;
  /**
   * Panel / secondary reference #RRGGBB. Default everforest --bg #272e33.
   * Reserved for dialog chrome alignment; typewriter unrevealed glyphs use
   * fully transparent Secondary (not bg camouflage).
   */
  bg?: string;
  /**
   * ASS Fontname. Default matches themes.css --font-body:
   * "Fusion Pixel 12px M zh_hans". Must be installed for libass/mpv.
   */
  font?: string;
  /** ASS Fontsize (PlayRes 1280x720 units). Default 36 typewriter / 42 plain. */
  fontSize?: number;
}

interface CaptionWord {
  startMs: number;
  endMs: number;
  text: string;
}

interface Caption {
  startMs: number;
  endMs: number;
  text: string;
  words?: CaptionWord[];
}

interface TimelineDoc {
  kind?: string;
  captions?: Caption[];
}

type AssStyle = "typewriter" | "plain";

/** everforest defaults matching templates/dialog + templates/_shared/themes.css */
const DEFAULT_BG = "#272e33";
const DEFAULT_FG = "#d3c6aa";
/** themes.css --font-body — pixel face used by markdown/dialog UI */
const DEFAULT_FONT = "Fusion Pixel 12px M zh_hans";

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

function msToSrt(ms: number): string {
  const x = Math.max(0, Math.trunc(ms));
  const h = Math.floor(x / 3600000);
  const m = Math.floor((x % 3600000) / 60000);
  const s = Math.floor((x % 60000) / 1000);
  const milli = x % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

/** ASS timestamps use centiseconds. */
function msToAss(ms: number): string {
  const x = Math.max(0, Math.trunc(ms));
  const h = Math.floor(x / 3600000);
  const m = Math.floor((x % 3600000) / 60000);
  const s = Math.floor((x % 60000) / 1000);
  const cs = Math.floor((x % 1000) / 10);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

/** Karaoke \k unit = centisecond. */
function msToK(ms: number): number {
  return Math.max(1, Math.round(Math.max(0, ms) / 10));
}

function escapeAss(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\N")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

/** #RRGGBB or RRGGBB → ASS &HAABBGGRR (AA=00 opaque). */
function hexToAssColour(hex: string, label: string): string {
  const raw = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    fail(`invalid ${label} color (want #RRGGBB): ${hex}`);
  }
  const rr = raw.slice(0, 2);
  const gg = raw.slice(2, 4);
  const bb = raw.slice(4, 6);
  return `&H00${bb}${gg}${rr}`.toUpperCase();
}

function toSrt(captions: Caption[]): string {
  return captions
    .map((c, i) => `${i + 1}\n${msToSrt(c.startMs)} --> ${msToSrt(c.endMs)}\n${c.text}\n`)
    .join("\n");
}

function normalizeWords(c: Caption): CaptionWord[] {
  return (c.words || [])
    .map((w) => ({
      startMs: Math.trunc(w.startMs),
      endMs: Math.trunc(w.endMs),
      text: String(w.text ?? ""),
    }))
    .filter((w) => w.endMs > w.startMs && w.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * Karaoke typewriter text for one cue.
 * Unrevealed syllables: Secondary fully transparent + Outline=0 → not painted.
 * Gaps between words become empty {\kN} advances (timing stays on speech).
 *
 * Reveal finishes by cueEnd - DIALOG_WAIT_TAIL_MS so the last glyphs land with
 * dialog wait-on / ▼ (same program-axis convention as buildDialogSequence).
 * Trailing empty \k holds the full line visible through the wait tail.
 */
function assKaraokeText(c: Caption): string {
  const words = normalizeWords(c);
  if (!words.length) return escapeAss(c.text);

  const start = Math.trunc(c.startMs);
  const end = Math.trunc(c.endMs);
  // Same tail as dialog ▼: finish glyph reveal before wait-on when possible.
  const revealEnd = Math.max(start + 1, end - DIALOG_WAIT_TAIL_MS);

  // Compress word spans into [start, revealEnd) proportionally so every glyph
  // still appears, then hold until cue end. Avoids mouth/ASS mismatch where
  // wait-on steals the last 250ms of speech while karaoke still types.
  const srcStart = Math.min(start, words[0].startMs);
  const srcEnd = Math.max(revealEnd, words[words.length - 1].endMs);
  const srcSpan = Math.max(1, srcEnd - srcStart);
  const dstSpan = Math.max(1, revealEnd - start);
  const mapT = (t: number) => start + Math.round(((t - srcStart) / srcSpan) * dstSpan);

  const parts: string[] = [];
  let cursor = start;
  for (const w of words) {
    const ws = Math.max(start, Math.min(revealEnd, mapT(w.startMs)));
    const we = Math.max(ws, Math.min(revealEnd, mapT(w.endMs)));
    if (ws > cursor) {
      parts.push(`{\\k${msToK(ws - cursor)}}`);
      cursor = ws;
    }
    const dur = Math.max(1, we - cursor);
    parts.push(`{\\k${msToK(dur)}}${escapeAss(w.text)}`);
    cursor = Math.min(revealEnd, cursor + dur);
  }
  if (end > cursor) parts.push(`{\\k${msToK(end - cursor)}}`);
  return parts.join("");
}

/** ASS Style Fontname cannot contain commas (field separator). */
function sanitizeFontName(name: string): string {
  const f = String(name || "").trim();
  if (!f) fail("font name is empty");
  if (f.includes(",")) fail(`font name must not contain commas (ASS field separator): ${f}`);
  return f;
}

function assHeader(opts: {
  styleName: "Typewriter" | "Default";
  font: string;
  fontSize: number;
  /** ASS PrimaryColour */
  fgAss: string;
  karaoke: boolean;
}): string {
  const { styleName, font, fontSize, fgAss, karaoke } = opts;
  // Karaoke typewriter (RPG dialogue):
  //   Secondary fully transparent → unrevealed FILL does not paint
  //   Outline width 0 → no ghost shells on unrevealed syllables
  // Plain: black outline for free-floating text.
  const secondary = karaoke ? "&HFF000000" : "&H000000FF"; // AA=FF transparent when karaoke
  const outlineCol = "&H00000000";
  const bold = karaoke ? -1 : 0;
  const outlineW = karaoke ? 0 : 3;
  // Dialog box is y=552..647 (templates/dialog/). Alignment=2 bottom-centre:
  // MarginV ≈ 100 keeps text inside the panel.
  const marginV = karaoke ? 100 : 64;
  const styleLine =
    `Style: ${styleName},${font},${fontSize},${fgAss},${secondary},${outlineCol},&H00000000,` +
    `${bold},0,0,0,100,100,0,0,1,${outlineW},0,2,80,80,${marginV},1`;

  return `[Script Info]
; uvid generate captions — program-axis subtitles
; Typewriter = karaoke \\k, transparent Secondary, Outline=0 (1 event/turn)
; Style params: font / fg / bg (bg reserved for panel alignment)
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/** Build ASS text from caption cues (shared by generate captions + generate video burn-in). */
export function buildAssFromCaptions(
  captions: Caption[],
  style: AssStyle,
  look: { fg?: string; bg?: string; font?: string; fontSize?: number } = {},
): string {
  return toAss(captions, style, {
    fg: look.fg || DEFAULT_FG,
    bg: look.bg || DEFAULT_BG,
    font: look.font || DEFAULT_FONT,
    fontSize: look.fontSize,
  });
}

function toAss(
  captions: Caption[],
  style: AssStyle,
  look: { fg: string; bg: string; font: string; fontSize?: number },
): string {
  const fgAss = hexToAssColour(look.fg, "--fg");
  // Validate bg even if not painted into karaoke secondary — keeps CLI honest.
  hexToAssColour(look.bg, "--bg");
  const font = sanitizeFontName(look.font);
  const karaoke = style === "typewriter";
  const styleName = style === "plain" ? "Default" : "Typewriter";
  const fontSize =
    look.fontSize != null && Number.isFinite(look.fontSize) && look.fontSize > 0
      ? Math.round(look.fontSize)
      : karaoke
        ? 36
        : 42;
  const header = assHeader({ styleName, font, fontSize, fgAss, karaoke });

  const lines: string[] = [];
  for (const c of captions) {
    if (style === "typewriter") {
      const body = assKaraokeText(c);
      const effect = (c.words?.length ?? 0) > 0 ? "Karaoke" : "";
      lines.push(
        `Dialogue: 0,${msToAss(c.startMs)},${msToAss(c.endMs)},${styleName},,0,0,0,${effect},${body}`,
      );
      continue;
    }
    // plain
    lines.push(
      `Dialogue: 0,${msToAss(c.startMs)},${msToAss(c.endMs)},${styleName},,0,0,0,,${escapeAss(c.text)}`,
    );
  }
  return header + lines.join("\n") + (lines.length ? "\n" : "");
}

function inferFormat(p: GenerateCaptionsParams): "srt" | "ass" {
  const f = (p.format || "").toLowerCase();
  if (f === "srt" || f === "ass") return f;
  if (p.output) {
    const ext = path.extname(p.output).toLowerCase();
    if (ext === ".ass") return "ass";
    if (ext === ".srt") return "srt";
  }
  return "srt";
}

function inferAssStyle(p: GenerateCaptionsParams, captions: Caption[]): AssStyle {
  const s = (p.style || "").toLowerCase();
  if (s === "plain") return "plain";
  if (s === "typewriter" || s === "karaoke" || s === "rpg") return "typewriter";
  if (s) fail(`unknown ASS --style ${JSON.stringify(p.style)} (want typewriter|plain)`);
  return captions.some((c) => (c.words?.length ?? 0) > 0) ? "typewriter" : "plain";
}

export async function generateCaptions(p: GenerateCaptionsParams, ctx: Ctx): Promise<void> {
  const input = resolveInput(ctx, p.input, "timeline.json");
  const output = resolveOutput(ctx, p.output);
  const { readInputJson } = await import("../io.ts");
  const raw = await readInputJson(ctx, input);
  if (!raw || typeof raw !== "object") fail("timeline.json must be an object");
  const tl = raw as TimelineDoc;
  if (tl.kind && tl.kind !== "uvid.timeline") fail(`expected kind uvid.timeline, got ${tl.kind}`);
  const captions = Array.isArray(tl.captions) ? (tl.captions as Caption[]) : [];

  const format = inferFormat(p);
  let text: string;
  let styleNote = "";
  if (format === "ass") {
    const style = inferAssStyle(p, captions);
    const bg = p.bg || DEFAULT_BG;
    const fg = p.fg || DEFAULT_FG;
    const font = p.font || DEFAULT_FONT;
    text = toAss(captions, style, { bg, fg, font, fontSize: p.fontSize });
    styleNote = ` style=${style} fg=${fg} bg=${bg} font=${JSON.stringify(font)}`;
  } else {
    text = toSrt(captions);
  }

  if (output.path) {
    ensureDir(path.dirname(output.path));
    fs.writeFileSync(output.path, text, "utf8");
    emitWrittenPath(ctx, output.path);
  } else if (ctx.toolHost) {
    ctx.log(text.trimEnd());
  } else {
    process.stdout.write(text);
  }
  const withWords = captions.filter((c) => (c.words?.length ?? 0) > 0).length;
  const events = (text.match(/^Dialogue:/gm) || []).length;
  ctx.log(
    `captions format=${format}${styleNote} cues=${captions.length} events=${events} withWords=${withWords}${
      output.path ? ` → ${rel(ctx, output.path)}` : ""
    }`,
  );
}
