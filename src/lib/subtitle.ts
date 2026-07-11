/**
 * Subtitle command: word-level typewriter ASS from timeline + draft JSON.
 */
import path from "node:path";
import fs from "node:fs";
import { type Ctx, ensureDir, fail, readJson, rel, resolveAgainst, resolveExisting, resolvePath } from "./util.ts";

function assTime(ms: number): string {
  ms = Math.max(0, Math.round(ms));
  const cs = Math.floor((ms % 1000) / 10);
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assClean(text: string): string {
  return String(text).replace(/[{}\\]/g, "").replace(/\r?\n/g, " ").trim();
}

function assUnits(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9_./|<>+-]+|\s+|./gu;
  for (const m of text.matchAll(re)) {
    const x = m[0];
    if (/^\s+$/.test(x)) {
      if (out.length) out[out.length - 1] += x;
    } else {
      out.push(x);
    }
  }
  return out.length ? out : [text];
}

function assSplitLine(text: string): string[] {
  const arr = assUnits(text);
  const lines: string[] = [];
  let cur = "";
  let w = 0;
  for (const u of arr) {
    const uw = /^[\x00-\x7F]+$/.test(u) ? Math.max(1, Math.ceil(u.length / 2)) : 2;
    if (cur && w + uw > 48) { lines.push(cur.trim()); cur = ""; w = 0; }
    cur += u;
    w += uw;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [text];
}

export interface SubtitleAssParams {
  input: string;
  output: string;
  font: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  pos: string;
  backColor?: string;
  bold?: boolean;
  outline?: number;
  shadow?: number;
}

/** Create the word-level typewriter ASS subtitle file (single-line RPG dialog style). */
export async function subtitleCreateAss(p: SubtitleAssParams, ctx: Ctx): Promise<void> {
  const timelinePath = resolveExisting(ctx, p.input, "input");
  const output = resolvePath(ctx, p.output);
  const fontSize = Math.round(p.fontSize);
  const backColor = p.backColor || "&H80000000";
  const bold = p.bold === false ? 0 : -1;
  const outlineSize = p.outline != null ? Math.round(p.outline) : 2;
  const shadowSize = p.shadow != null ? Math.round(p.shadow) : 2;
  const posParts = p.pos.split(",").map(Number);
  if (posParts.length !== 2 || posParts.some((n: any) => !Number.isFinite(n))) fail(`invalid --pos: ${p.pos} (expected x,y)`);

  const tl = readJson(timelinePath);
  const scenes = tl.scenes || [];
  const draftRef = (tl.derivedFrom || {}).draft || (tl.derivedFrom || {}).edit || "";
  const editPath = resolveAgainst(timelinePath, draftRef);
  if (!fs.existsSync(editPath)) fail(`draft.json referenced by timeline not found: ${editPath}`);
  const edit = readJson(editPath);

  const scenesBySource = new Map<string, any>();
  for (const s of scenes) {
    if (s.voice) {
      const m = String(s.voice.path).match(/src-([^/.]+)\.wav$/);
      if (m) scenesBySource.set(m[1], { ...s, voiceOffsetMs: s.voice.offsetMs || s.timelineStartMs || 0 });
    }
  }

  let assBody = "";
  const talkIntervals: Array<[number, number]> = [];
  const waitIntervals: Array<[number, number]> = [];
  const timelineEvents: any[] = [];

  for (const src of edit.sources || []) {
    const scene = scenesBySource.get(src.id);
    if (!scene) continue;
    for (const sub of src.subtitles || []) {
      const start = scene.voiceOffsetMs + (sub.sourceLocalStartMs || 0);
      const end = scene.voiceOffsetMs + (sub.sourceLocalEndMs || 0);
      const lines = assSplitLine(assClean(sub.text));
      if (lines.length > 1) {
        const totalChars = lines.reduce((n: number, x: string) => n + x.length, 0) || 1;
        let cur = start;
        for (const line of lines) {
          const dur = Math.max(400, Math.round((end - start) * line.length / totalChars));
          timelineEvents.push({ start: cur, end: Math.min(end, cur + dur), text: line });
          cur += dur;
        }
      } else {
        timelineEvents.push({ start, end, text: lines[0] || assClean(sub.text) });
      }
    }
  }
  timelineEvents.sort((a: any, b: any) => a.start - b.start);

  for (const ev of timelineEvents) {
    const text = assClean(ev.text);
    const u = assUnits(text);
    const revealSpan = Math.max(120, Math.min(ev.end - ev.start - 120, Math.round((ev.end - ev.start) * 0.72)));
    const step = u.length <= 1 ? revealSpan : revealSpan / (u.length - 1);
    const lastReveal = Math.max(ev.start, Math.min(ev.end - 80, Math.round(ev.start + revealSpan)));
    for (let i = 0; i < u.length; i++) {
      const st = i === 0 ? ev.start : Math.round(ev.start + step * i);
      const en = i === u.length - 1 ? ev.end : Math.round(ev.start + step * (i + 1));
      if (en <= st) continue;
      const prefix = assClean(u.slice(0, i + 1).join(""));
      assBody += `Dialogue: 0,${assTime(st)},${assTime(en)},Default,,0,0,0,,{\\an4\\pos(${p.pos})\\q2}${prefix}\n`;
    }
    if (lastReveal > ev.start) talkIntervals.push([ev.start, lastReveal]);
    if (ev.end > lastReveal) waitIntervals.push([lastReveal, ev.end]);
  }

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1280",
    "PlayResY: 720",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${p.font},${fontSize},${p.color},&H000000FF,${p.outlineColor},${backColor},${bold},0,0,0,100,100,0,0,1,${outlineSize},${shadowSize},4,20,20,20,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    assBody,
  ].join("\n");

  ensureDir(path.dirname(output));
  fs.writeFileSync(output, header + "\n");
  ctx.log(`uvid finish subtitle: wrote ${rel(ctx, output)}`);
  ctx.log(`  events: ${timelineEvents.length}, talk: ${talkIntervals.length}, wait: ${waitIntervals.length}`);
}
