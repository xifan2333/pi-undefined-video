/**
 * BGM generation: compact NES-style MML -> FamiStudio text -> MP3.
 */
import fs from "node:fs";
import path from "node:path";
import { type Ctx, ensureDir, fail, rel, resolveExisting, resolvePath } from "./util.ts";
import { exec } from "./proc.ts";
import { audioCreateLoudness } from "./prep.ts";

export interface BgmCreateParams {
  input: string;
  output: string;
  duration?: number;
  rate?: number;
  bitrate?: number;
  textOutput?: string;
}

interface Event {
  timeUnits: number;
  durUnits: number;
  value: string;
  instrument: string;
}

interface SongSpec {
  title: string;
  tempo: number;
  patternLength: number;
  noteFrames: number;
  channels: Record<string, Event[]>;
}

const CHANNELS: Record<string, string> = {
  S1: "Square1",
  S2: "Square2",
  TR: "Triangle",
  NO: "Noise",
};

const DEFAULT_INSTR: Record<string, string> = {
  S1: "Lead",
  S2: "Pad",
  TR: "Bass",
  NO: "NoiseHat",
};

const INSTR_ALIAS: Record<string, string> = {
  lead: "Lead",
  pad: "Pad",
  echo: "Pad",
  pluck: "Lead",
  bass: "Bass",
  kick: "NoiseKick",
  snare: "NoiseSnare",
  hat: "NoiseHat",
  hihat: "NoiseHat",
  tom: "NoiseTom",
};

const DRUMS: Record<string, { value: string; instrument: string }> = {
  k: { value: "F#3", instrument: "NoiseKick" },
  s: { value: "G#3", instrument: "NoiseSnare" },
  h: { value: "A#3", instrument: "NoiseHat" },
  t: { value: "C#4", instrument: "NoiseTom" },
};

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function stripComment(line: string): string {
  return line.replace(/\s*(#|;|\/\/).*$/, "").trim();
}

function expandLoops(src: string): string {
  // Expand simple MML loops: [cdef]x2 or [cdef]2. Nested loops are expanded inside-out.
  let s = src;
  const re = /\[([^\[\]]+)\]\s*(?:x)?(\d+)/i;
  for (let guard = 0; guard < 100 && re.test(s); guard++) {
    s = s.replace(re, (_m, body, n) => Array(Number(n)).fill(body).join(" "));
  }
  return s;
}

function lengthToUnits(denom: number, dotted: boolean): number {
  if (!Number.isFinite(denom) || denom <= 0) fail(`invalid MML note length: ${denom}`);
  let units = 16 / denom;
  if (dotted) units *= 1.5;
  const rounded = Math.round(units);
  if (Math.abs(units - rounded) > 1e-6 || rounded <= 0) fail(`unsupported MML note length: ${denom}${dotted ? "." : ""} (must map to 16th-note grid)`);
  return rounded;
}

function parseLength(mml: string, i: number, defaultDenom: number): { units: number; next: number } {
  let j = i;
  while (j < mml.length && /\d/.test(mml[j])) j++;
  const denom = j > i ? Number(mml.slice(i, j)) : defaultDenom;
  let dotted = false;
  if (mml[j] === ".") { dotted = true; j++; }
  return { units: lengthToUnits(denom, dotted), next: j };
}

function noteName(ch: string, accidental: string, octave: number): string {
  const n = ch.toUpperCase();
  const acc = accidental === "+" ? "#" : accidental;
  return `${n}${acc}${octave}`;
}

function parseChannel(code: string, channel: string): Event[] {
  const src = expandLoops(code).replace(/\|/g, " ");
  const events: Event[] = [];
  let i = 0;
  let time = 0;
  let octave = channel === "TR" ? 2 : channel === "NO" ? 3 : 4;
  let defaultDenom = 8;
  let instrument = DEFAULT_INSTR[channel] || "Lead";

  while (i < src.length) {
    const c = src[i];
    if (/\s|,/.test(c)) { i++; continue; }
    if (c === "@") {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_-]/.test(src[j])) j++;
      const name = src.slice(i + 1, j).toLowerCase();
      instrument = INSTR_ALIAS[name] || name;
      i = j;
      continue;
    }
    if (c === "o" || c === "O") {
      let j = i + 1;
      while (j < src.length && /\d/.test(src[j])) j++;
      octave = Number(src.slice(i + 1, j));
      if (!Number.isFinite(octave)) fail(`invalid octave near: ${src.slice(i, i + 8)}`);
      i = j;
      continue;
    }
    if (c === "l" || c === "L") {
      let j = i + 1;
      while (j < src.length && /\d/.test(src[j])) j++;
      defaultDenom = Number(src.slice(i + 1, j));
      lengthToUnits(defaultDenom, false);
      i = j;
      continue;
    }
    if (c === ">") { octave++; i++; continue; }
    if (c === "<") { octave--; i++; continue; }

    const low = c.toLowerCase();
    if (low === "r") {
      const { units, next } = parseLength(src, i + 1, defaultDenom);
      time += units;
      i = next;
      continue;
    }
    if (channel === "NO" && DRUMS[low]) {
      const { units, next } = parseLength(src, i + 1, defaultDenom);
      const d = DRUMS[low];
      events.push({ timeUnits: time, durUnits: units, value: d.value, instrument: d.instrument });
      time += units;
      i = next;
      continue;
    }
    if (/[a-gA-G]/.test(c)) {
      let j = i + 1;
      let accidental = "";
      if (src[j] === "#" || src[j] === "+" || src[j] === "-") accidental = src[j++];
      const { units, next } = parseLength(src, j, defaultDenom);
      events.push({ timeUnits: time, durUnits: units, value: noteName(c, accidental, octave), instrument });
      time += units;
      i = next;
      continue;
    }
    fail(`unsupported MML token near: ${src.slice(i, i + 16)}`);
  }
  return events;
}

function parseMml(text: string): SongSpec {
  const header: Record<string, string> = {};
  const channelText: Record<string, string[]> = { S1: [], S2: [], TR: [], NO: [] };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^"|"$/g, "");
    const upper = key.toUpperCase();
    if (upper in channelText) channelText[upper].push(value);
    else header[key.toLowerCase()] = value;
  }

  const title = header.title || "Undefined BGM";
  const tempo = Number(header.tempo || 132);
  if (!Number.isFinite(tempo) || tempo <= 0) fail(`invalid tempo: ${header.tempo}`);
  const patternLength = Number(header.patternlength || header.pattern || 16);
  if (!Number.isInteger(patternLength) || patternLength <= 0) fail(`invalid patternLength: ${patternLength}`);
  const noteFrames = Math.max(1, Math.round(900 / tempo)); // frames per 16th note @ 60Hz.

  const channels: Record<string, Event[]> = {};
  for (const ch of Object.keys(channelText)) {
    const code = channelText[ch].join(" ");
    channels[ch] = code.trim() ? parseChannel(code, ch) : [];
  }
  if (!Object.values(channels).some((ev) => ev.length > 0)) fail("MML contains no channel notes (expected S1/S2/TR/NO lines)");
  return { title, tempo, patternLength, noteFrames, channels };
}

function instrumentLines(): string[] {
  return [
    `\tInstrument Name="Lead" Color="4fc3f7"`,
    `\t\tEnvelope Type="Volume" Length="8" Values="12,12,10,10,8,7,6,4"`,
    `\t\tEnvelope Type="DutyCycle" Length="1" Values="2"`,
    `\tInstrument Name="Pad" Color="9575cd"`,
    `\t\tEnvelope Type="Volume" Length="6" Values="8,8,7,7,6,5"`,
    `\t\tEnvelope Type="DutyCycle" Length="1" Values="1"`,
    `\tInstrument Name="Bass" Color="aed581"`,
    `\t\tEnvelope Type="Volume" Length="1" Values="10"`,
    `\tInstrument Name="NoiseKick" Color="ff8a65"`,
    `\t\tEnvelope Type="Volume" Length="2" Values="13,0"`,
    `\tInstrument Name="NoiseSnare" Color="26c6da"`,
    `\t\tEnvelope Type="Volume" Length="8" Values="13,11,9,7,5,3,1,0"`,
    `\t\tEnvelope Type="Arpeggio" Length="2" Values="-7,0"`,
    `\tInstrument Name="NoiseHat" Color="fff176"`,
    `\t\tEnvelope Type="Volume" Length="3" Values="8,4,0"`,
    `\tInstrument Name="NoiseTom" Color="f06292"`,
    `\t\tEnvelope Type="Volume" Length="5" Values="11,9,6,3,0"`,
    `\t\tEnvelope Type="Pitch" Length="5" Values="4,2,0,-2,-4"`,
  ];
}

function emitChannel(ch: string, events: Event[], patternLength: number, noteFrames: number, totalPatterns: number): string[] {
  const lines: string[] = [];
  lines.push(`\t\tChannel Type="${CHANNELS[ch]}"`);
  const byPattern = new Map<number, Event[]>();
  for (const ev of events) {
    const pi = Math.floor(ev.timeUnits / patternLength);
    if (!byPattern.has(pi)) byPattern.set(pi, []);
    byPattern.get(pi)!.push(ev);
  }
  for (let pi = 0; pi < totalPatterns; pi++) {
    const evs = byPattern.get(pi) || [];
    if (evs.length === 0) continue;
    const name = `${ch}_${pi}`;
    lines.push(`\t\t\tPattern Name="${name}" Color="4fc3f7"`);
    for (const ev of evs) {
      const t = (ev.timeUnits - pi * patternLength) * noteFrames;
      const d = Math.max(1, ev.durUnits * noteFrames - 1);
      lines.push(`\t\t\t\tNote Time="${t}" Value="${ev.value}" Duration="${d}" Instrument="${ev.instrument}"`);
    }
    lines.push(`\t\t\tPatternInstance Time="${pi}" Pattern="${name}"`);
  }
  return lines;
}

function emitFamiStudioText(spec: SongSpec): string {
  const maxUnits = Math.max(...Object.values(spec.channels).flat().map((e) => e.timeUnits + e.durUnits));
  const totalPatterns = Math.max(1, Math.ceil(maxUnits / spec.patternLength));
  const lines: string[] = [];
  lines.push(`Project Version="4.5.1" TempoMode="FamiStudio" Name="${escapeAttr(spec.title)}"`);
  lines.push(...instrumentLines());
  lines.push(`\tSong Name="Main" Color="ff8a65" Length="${totalPatterns}" LoopPoint="0" PatternLength="${spec.patternLength}" BeatLength="4" NoteLength="${spec.noteFrames}" Groove="${spec.noteFrames}" GroovePaddingMode="Middle"`);
  for (const ch of ["S1", "S2", "TR", "NO"]) {
    lines.push(...emitChannel(ch, spec.channels[ch] || [], spec.patternLength, spec.noteFrames, totalPatterns));
  }
  return lines.join("\n") + "\n";
}

async function runFamiStudio(input: string, output: string, rate: number, bitrate: number, duration: number | undefined, ctx: Ctx): Promise<void> {
  const dll = "/usr/share/famistudio/FamiStudio.dll";
  const args = fs.existsSync(dll)
    ? [dll, input, "mp3-export", output]
    : [input, "mp3-export", output];
  args.push(`-mp3-export-rate:${rate}`, `-mp3-export-bitrate:${bitrate}`);
  if (duration != null && duration > 0) args.push(`-mp3-export-duration:${duration}`);
  if (fs.existsSync(dll)) await exec("dotnet", args, { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
  else await exec("famistudio", args, { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
}

/** Create a chiptune BGM MP3 from compact NES-style MML. */
export async function audioCreateBgm(p: BgmCreateParams, ctx: Ctx): Promise<void> {
  const input = resolveExisting(ctx, p.input, "input");
  const output = resolvePath(ctx, p.output);
  ensureDir(path.dirname(output));

  const rate = p.rate ?? 48000;
  if (![44100, 48000].includes(rate)) fail(`FamiStudio MP3 export rate must be 44100 or 48000: ${rate}`);
  const bitrate = p.bitrate ?? 192;
  if (![96, 112, 128, 160, 192, 224, 256].includes(bitrate)) fail(`FamiStudio MP3 bitrate unsupported: ${bitrate}`);
  if (p.duration != null && p.duration <= 0) fail(`duration must be > 0: ${p.duration}`);

  const spec = parseMml(fs.readFileSync(input, "utf8"));
  const text = emitFamiStudioText(spec);
  const textOutput = p.textOutput ? resolvePath(ctx, p.textOutput) : output.replace(/\.[^.]+$/, ".famistudio.txt");
  ensureDir(path.dirname(textOutput));
  fs.writeFileSync(textOutput, text);

  const rawOutput = output.replace(/\.[^.]+$/, ".raw.mp3");

  ctx.log(`uvid finish bgm: ${rel(ctx, input)} → ${rel(ctx, output)}`);
  ctx.log(`  title=${spec.title}, tempo≈${spec.tempo}bpm, noteFrames=${spec.noteFrames}, rate=${rate}, bitrate=${bitrate}k`);
  ctx.log(`  wrote FamiStudio text: ${rel(ctx, textOutput)}`);
  ctx.log(`  pass 1: FamiStudio MP3 export → ${rel(ctx, rawOutput)}`);
  await runFamiStudio(textOutput, rawOutput, rate, bitrate, p.duration, ctx);
  ctx.log("  pass 2: fixed BGM loudness → I=-42 LUFS, TP=-9 dBTP, LRA=11");
  await audioCreateLoudness({ input: rawOutput, output, lufs: -42, tp: -9, lra: 11 }, ctx);
  fs.rmSync(rawOutput, { force: true });
  ctx.log("uvid finish bgm: done");
}
