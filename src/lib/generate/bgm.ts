/**
 * uvid generate bgm — bgm.mml → one audio file (default mp3).
 *
 * Pipeline: MML → FamiStudio text → FamiStudio mp3-export → loudnorm.
 * Does NOT read edit.json. Duration is an explicit export length (seconds).
 *
 * Creative layer (AI writes): progression + S1 melody.
 * Craft layer (engine fills): empty S2/TR/NO from style/s2mode/bass.
 * Hand-written channels always win. S1 is never generated.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatExt, resolveFormat, type MediaFormat } from "../format.ts";
import { materializeInput, openFilterIo, publishFileOutput } from "../io.ts";
import { exec, ffmpeg } from "../proc.ts";
import { type Ctx, ensureDir, fail, rel } from "../util.ts";

export interface GenerateBgmParams {
  input?: string;
  output?: string;
  /** Export length in seconds (FamiStudio -mp3-export-duration). Omit = full song. */
  duration?: number;
  /** Sample rate: 44100 | 48000. Default 48000. */
  sampleRate?: number;
  /** FamiStudio export bitrate kbps. Default 192. */
  bitrate?: number;
  /** Final container after loudnorm: mp3 (default) | wav | aac. */
  format?: string;
  /** Fixed bed loudness. Default -42. */
  lufs?: number;
  /** True peak. Default -9. */
  tp?: number;
  /** Loudness range. Default 11. */
  lra?: number;
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
  swing: number; // 0..1, shifts off-eighths later in the bar
  channels: Record<string, Event[]>;
  generated: string[];
  style?: string;
  s2mode?: string;
  bass?: string;
  progressionBars?: number;
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
  echo: "Echo",
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

// ── chord / accompaniment engine ─────────────────────────────────────────

const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PC_OF: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const CHORD_QUALITIES: Record<string, number[]> = {
  "": [0, 4, 7],
  maj: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  "5": [0, 7, 12],
};

interface Chord {
  symbol: string;
  rootPc: number; // 0-11 relative to C
  intervals: number[]; // semitones from root
}

function parseChord(symbol: string): Chord {
  const m = symbol.match(/^([A-Ga-g])([#b]?)(.*)$/);
  if (!m) fail(`invalid chord symbol: ${symbol}`);
  let rootPc = PC_OF[m[1].toLowerCase()];
  if (m[2] === "#") rootPc = (rootPc + 1) % 12;
  if (m[2] === "b") rootPc = (rootPc + 11) % 12;
  const quality = m[3];
  const intervals = CHORD_QUALITIES[quality] ?? CHORD_QUALITIES[quality.toLowerCase()];
  if (!intervals) {
    fail(
      `unsupported chord quality "${quality}" in ${symbol} (supported: ${Object.keys(CHORD_QUALITIES)
        .filter(Boolean)
        .join(", ")})`,
    );
  }
  return { symbol, rootPc, intervals };
}

function parseProgression(text: string): Chord[] {
  const tokens = expandLoops(text).replace(/\|/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) fail("progression is empty");
  return tokens.map(parseChord);
}

/** Absolute semitone (C0-based) → FamiStudio note name like "A#2". */
function absNote(abs: number): string {
  return `${PC_NAMES[((abs % 12) + 12) % 12]}${Math.floor(abs / 12)}`;
}

/** Parse FamiStudio note name (C4 / A#3 / Bb2) → absolute semitone. */
function parseNoteValue(value: string): number {
  const m = value.match(/^([A-G])([#b]?)(-?\d+)$/i);
  if (!m) fail(`invalid note value: ${value}`);
  let pc = PC_OF[m[1].toLowerCase()];
  if (m[2] === "#") pc = (pc + 1) % 12;
  if (m[2] === "b") pc = (pc + 11) % 12;
  return Number(m[3]) * 12 + pc;
}

/** Chord tone i (clamped by modulo) as absolute semitone above baseAbs. */
function chordTone(chord: Chord, i: number, baseAbs: number): number {
  return baseAbs + chord.rootPc + chord.intervals[i % chord.intervals.length];
}

/** Absolute chord tones in a pitch range (for walk / thirds). */
function chordAbsTones(chord: Chord, minAbs: number, maxAbs: number): number[] {
  const out: number[] = [];
  for (let oct = 0; oct <= 6; oct++) {
    for (const iv of chord.intervals) {
      const abs = oct * 12 + chord.rootPc + iv;
      if (abs >= minAbs && abs <= maxAbs) out.push(abs);
    }
  }
  return out.sort((a, b) => a - b);
}

interface StyleStep {
  slot: number; // 0-15 (16th-note grid within one bar)
  len: number; // slots
  tone: number | "root" | "root5" | "k" | "s" | "h" | "t";
}

interface StyleDef {
  TR: StyleStep[];
  S2: StyleStep[];
  NO: StyleStep[];
}

const STYLES: Record<string, StyleDef> = {
  // Driving 8ths: root bass, arpeggio pad, backbeat drums.
  drive: {
    TR: [0, 2, 4, 6, 8, 10, 12, 14].map((slot) => ({ slot, len: 2, tone: "root" as const })),
    S2: [0, 1, 2, 1, 0, 1, 2, 1].map((tone, i) => ({ slot: i * 2, len: 2, tone })),
    NO: [
      { slot: 0, len: 1, tone: "k" }, { slot: 2, len: 1, tone: "h" },
      { slot: 4, len: 1, tone: "s" }, { slot: 6, len: 1, tone: "h" },
      { slot: 8, len: 1, tone: "k" }, { slot: 10, len: 1, tone: "h" },
      { slot: 12, len: 1, tone: "s" }, { slot: 14, len: 1, tone: "h" },
    ],
  },
  // Sparse and sustained: half-note bass, long pad tones, minimal percussion.
  chill: {
    TR: [
      { slot: 0, len: 8, tone: "root" },
      { slot: 8, len: 8, tone: "root5" },
    ],
    S2: [
      { slot: 0, len: 8, tone: 1 },
      { slot: 8, len: 8, tone: 2 },
    ],
    NO: [
      { slot: 0, len: 1, tone: "k" },
      { slot: 8, len: 1, tone: "h" },
    ],
  },
  // Pulsing 16th bass, offbeat stabs, syncopated drums.
  tense: {
    TR: Array.from({ length: 16 }, (_, slot) => ({ slot, len: 1, tone: "root" as const })),
    S2: [
      { slot: 2, len: 1, tone: 1 }, { slot: 6, len: 1, tone: 2 },
      { slot: 10, len: 1, tone: 1 }, { slot: 14, len: 1, tone: 2 },
    ],
    NO: [
      { slot: 0, len: 1, tone: "k" }, { slot: 2, len: 1, tone: "h" },
      { slot: 4, len: 1, tone: "s" }, { slot: 6, len: 1, tone: "h" },
      { slot: 7, len: 1, tone: "k" }, { slot: 8, len: 1, tone: "k" },
      { slot: 10, len: 1, tone: "h" }, { slot: 12, len: 1, tone: "s" },
      { slot: 14, len: 1, tone: "h" },
    ],
  },
};

const BASS_BASE = 24; // o2
const PAD_BASE = 36; // o3
const S2_MODES = new Set(["arp", "echo", "thirds"]);
const BASS_MODES = new Set(["root", "walk"]);

function styleStepEvents(ch: "TR" | "S2" | "NO", step: StyleStep, chord: Chord, barStart: number, scale: number): Event {
  const timeUnits = barStart + step.slot * scale;
  const durUnits = step.len * scale;
  if (ch === "NO") {
    const d = DRUMS[step.tone as string];
    return { timeUnits, durUnits, value: d.value, instrument: d.instrument };
  }
  const instrument = DEFAULT_INSTR[ch];
  if (step.tone === "root") return { timeUnits, durUnits, value: absNote(BASS_BASE + chord.rootPc), instrument };
  if (step.tone === "root5") return { timeUnits, durUnits, value: absNote(BASS_BASE + chord.rootPc + 7), instrument };
  const base = ch === "TR" ? BASS_BASE : PAD_BASE;
  return { timeUnits, durUnits, value: absNote(chordTone(chord, step.tone as number, base)), instrument };
}

/** Melodic bass line: root-5-8-3 + approach into next chord. */
function walkBassEvents(chord: Chord, next: Chord, barStart: number, scale: number): Event[] {
  const root = BASS_BASE + chord.rootPc;
  const fifth = root + 7;
  const octave = root + 12;
  const third = root + (chord.intervals.includes(3) ? 3 : 4);
  const approachTarget = BASS_BASE + next.rootPc;
  // Prefer half-step below next root; fall back to whole step if that collides with current root.
  let approach = approachTarget - 1;
  if (approach === root) approach = approachTarget - 2;
  const tones = [root, fifth, octave, third, root, fifth, third, approach];
  return tones.map((abs, i) => ({
    timeUnits: barStart + i * 2 * scale,
    durUnits: 2 * scale,
    value: absNote(abs),
    instrument: "Bass",
  }));
}

/** Delayed quieter copy of S1 (fixed 2-unit delay ≈ one 8th at default grid). */
function echoFromS1(s1: Event[], delayUnits = 2): Event[] {
  return s1.map((ev) => ({
    timeUnits: ev.timeUnits + delayUnits,
    durUnits: Math.max(1, ev.durUnits - 1),
    value: ev.value,
    instrument: "Echo",
  }));
}

/**
 * Parallel diatonic harmony: for each S1 note, pick the nearest chord tone
 * at least a minor third below. Falls back to -3 semitones if no chord tone fits.
 */
function thirdsFromS1(s1: Event[], progression: Chord[], patternLength: number): Event[] {
  return s1.map((ev) => {
    const chord = progression[Math.floor(ev.timeUnits / patternLength) % progression.length];
    const mel = parseNoteValue(ev.value);
    const candidates = chordAbsTones(chord, mel - 16, mel - 3);
    const pick = candidates.length > 0 ? candidates[candidates.length - 1] : mel - 3;
    return {
      timeUnits: ev.timeUnits,
      durUnits: ev.durUnits,
      value: absNote(pick),
      instrument: "Pad",
    };
  });
}

/**
 * Fill empty S2/TR/NO channels from a chord progression + style/s2mode/bass.
 * Hand-written channels always win; S1 (melody) is never generated.
 */
function generateAccompaniment(
  spec: SongSpec,
  progression: Chord[],
  styleName: string,
  s2mode: string,
  bass: string,
): void {
  const style = STYLES[styleName];
  if (!style) fail(`unknown style "${styleName}" (supported: ${Object.keys(STYLES).join(", ")})`);
  if (!S2_MODES.has(s2mode)) fail(`unknown s2mode "${s2mode}" (supported: ${[...S2_MODES].join(", ")})`);
  if (!BASS_MODES.has(bass)) fail(`unknown bass "${bass}" (supported: ${[...BASS_MODES].join(", ")})`);
  const scale = spec.patternLength / 16;
  if (!Number.isInteger(scale) || scale <= 0) {
    fail(`progression requires patternLength to be a multiple of 16, got ${spec.patternLength}`);
  }

  const handUnits = Math.max(0, ...Object.values(spec.channels).flat().map((e) => e.timeUnits + e.durUnits));
  const songBars = Math.max(Math.ceil(handUnits / spec.patternLength), progression.length);

  // TR
  if (spec.channels.TR.length === 0) {
    const events: Event[] = [];
    for (let bar = 0; bar < songBars; bar++) {
      const chord = progression[bar % progression.length];
      const next = progression[(bar + 1) % progression.length];
      const barStart = bar * spec.patternLength;
      if (bass === "walk") events.push(...walkBassEvents(chord, next, barStart, scale));
      else for (const step of style.TR) events.push(styleStepEvents("TR", step, chord, barStart, scale));
    }
    spec.channels.TR = events;
    spec.generated.push("TR");
  }

  // S2
  if (spec.channels.S2.length === 0) {
    if (s2mode === "echo") {
      if (spec.channels.S1.length === 0) fail("s2mode: echo requires a hand-written S1 melody");
      spec.channels.S2 = echoFromS1(spec.channels.S1);
    } else if (s2mode === "thirds") {
      if (spec.channels.S1.length === 0) fail("s2mode: thirds requires a hand-written S1 melody");
      spec.channels.S2 = thirdsFromS1(spec.channels.S1, progression, spec.patternLength);
    } else {
      const events: Event[] = [];
      for (let bar = 0; bar < songBars; bar++) {
        const chord = progression[bar % progression.length];
        const barStart = bar * spec.patternLength;
        for (const step of style.S2) events.push(styleStepEvents("S2", step, chord, barStart, scale));
      }
      spec.channels.S2 = events;
    }
    spec.generated.push("S2");
  }

  // NO
  if (spec.channels.NO.length === 0) {
    const events: Event[] = [];
    for (let bar = 0; bar < songBars; bar++) {
      const chord = progression[bar % progression.length];
      const barStart = bar * spec.patternLength;
      for (const step of style.NO) events.push(styleStepEvents("NO", step, chord, barStart, scale));
    }
    spec.channels.NO = events;
    spec.generated.push("NO");
  }

  spec.style = styleName;
  spec.s2mode = s2mode;
  spec.bass = bass;
  spec.progressionBars = progression.length;
}

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
  if (Math.abs(units - rounded) > 1e-6 || rounded <= 0) {
    fail(`unsupported MML note length: ${denom}${dotted ? "." : ""} (must map to 16th-note grid)`);
  }
  return rounded;
}

function parseLength(mml: string, i: number, defaultDenom: number): { units: number; next: number } {
  let j = i;
  while (j < mml.length && /\d/.test(mml[j])) j++;
  const denom = j > i ? Number(mml.slice(i, j)) : defaultDenom;
  let dotted = false;
  if (mml[j] === ".") {
    dotted = true;
    j++;
  }
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
    if (/\s|,/.test(c)) {
      i++;
      continue;
    }
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
    if (c === ">") {
      octave++;
      i++;
      continue;
    }
    if (c === "<") {
      octave--;
      i++;
      continue;
    }

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

function parseBoolish(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseSwing(v: string | undefined): number {
  if (v == null || v === "") return 0;
  if (parseBoolish(v)) return 0.5; // default shuffle feel
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) fail(`invalid swing (expect 0..1 or true/false): ${v}`);
  return n;
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
  const swing = parseSwing(header.swing);

  const channels: Record<string, Event[]> = {};
  for (const ch of Object.keys(channelText)) {
    const code = channelText[ch].join(" ");
    channels[ch] = code.trim() ? parseChannel(code, ch) : [];
  }
  const spec: SongSpec = {
    title,
    tempo,
    patternLength,
    noteFrames,
    swing,
    channels,
    generated: [],
  };
  if (header.progression) {
    generateAccompaniment(
      spec,
      parseProgression(header.progression),
      (header.style || "drive").toLowerCase(),
      (header.s2mode || "arp").toLowerCase(),
      (header.bass || "root").toLowerCase(),
    );
  } else if (header.style || header.s2mode || header.bass) {
    fail("style/s2mode/bass require a progression line (e.g. progression: Am F C G)");
  }
  if (!Object.values(channels).some((ev) => ev.length > 0)) {
    fail("MML contains no channel notes (expected S1/S2/TR/NO lines, or a progression)");
  }
  return spec;
}

function instrumentLines(): string[] {
  return [
    `\tInstrument Name="Lead" Color="4fc3f7"`,
    `\t\tEnvelope Type="Volume" Length="8" Values="12,12,10,10,8,7,6,4"`,
    `\t\tEnvelope Type="DutyCycle" Length="1" Values="2"`,
    `\tInstrument Name="Pad" Color="9575cd"`,
    `\t\tEnvelope Type="Volume" Length="6" Values="8,8,7,7,6,5"`,
    `\t\tEnvelope Type="DutyCycle" Length="1" Values="1"`,
    `\tInstrument Name="Echo" Color="80deea"`,
    `\t\tEnvelope Type="Volume" Length="8" Values="6,6,5,4,3,2,1,0"`,
    `\t\tEnvelope Type="DutyCycle" Length="1" Values="2"`,
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

/**
 * Map a unit position (16th grid) onto frames, optionally swinging off-eighths.
 *
 * FamiStudio's native Groove only allows adjacent-frame pairs (max-min ≤ 1),
 * so real shuffle is done by shifting Note Time off the uniform grid — validated
 * against FamiStudio 4.5 text import (arbitrary frame times round-trip cleanly).
 *
 * Within each quarter (4 sixteenths = 2 eighths):
 *   onbeat 8th (units 0-1) keeps full length 2·nf + delay
 *   offbeat 8th (units 2-3) is delayed, length 2·nf - delay
 * where delay = round(swing · nf). swing=0.5 ≈ light shuffle; 1.0 ≈ hard 3:1.
 */
function unitsToFrames(units: number, noteFrames: number, swing: number): number {
  if (swing <= 0) return Math.round(units * noteFrames);
  const delay = Math.round(swing * noteFrames);
  const whole = Math.floor(units);
  const frac = units - whole;
  const quarters = Math.floor(whole / 4);
  const rem = whole - quarters * 4; // 0..3 within the quarter
  const base = quarters * 4 * noteFrames;
  const longLen = 2 * noteFrames + delay;
  const shortLen = 2 * noteFrames - delay;
  let frames: number;
  if (rem < 2) {
    // first (long) eighth of the pair
    frames = base + (rem / 2) * longLen;
  } else {
    // second (short, delayed) eighth
    frames = base + longLen + ((rem - 2) / 2) * shortLen;
  }
  // fractional unit (rare; dotted lengths already expand to integer units)
  const slice = rem < 2 ? longLen / 2 : shortLen / 2;
  return Math.round(frames + frac * slice);
}

function emitChannel(
  ch: string,
  events: Event[],
  patternLength: number,
  noteFrames: number,
  totalPatterns: number,
  swing: number,
): string[] {
  const lines: string[] = [];
  lines.push(`\t\tChannel Type="${CHANNELS[ch]}"`);
  const byPattern = new Map<number, Event[]>();
  for (const ev of events) {
    const pi = Math.floor(ev.timeUnits / patternLength);
    if (!byPattern.has(pi)) byPattern.set(pi, []);
    byPattern.get(pi)!.push(ev);
  }
  const patternFrames = patternLength * noteFrames;
  for (let pi = 0; pi < totalPatterns; pi++) {
    const evs = byPattern.get(pi) || [];
    if (evs.length === 0) continue;
    const name = `${ch}_${pi}`;
    lines.push(`\t\t\tPattern Name="${name}" Color="4fc3f7"`);
    for (const ev of evs) {
      const localStart = ev.timeUnits - pi * patternLength;
      const localEnd = localStart + ev.durUnits;
      const t = unitsToFrames(localStart, noteFrames, swing);
      // Clamp end so a swung offbeat near the pattern edge doesn't spill into the next pattern.
      const endFrames = Math.min(patternFrames, unitsToFrames(localEnd, noteFrames, swing));
      const d = Math.max(1, endFrames - t - (swing > 0 ? 0 : 1));
      // Keep the classic 1-frame gap for non-swing (matches prior export); swing uses exact span.
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
  // Groove stays uniform; swing is realized by shifted Note Times (see unitsToFrames).
  lines.push(
    `\tSong Name="Main" Color="ff8a65" Length="${totalPatterns}" LoopPoint="0" PatternLength="${spec.patternLength}" BeatLength="4" NoteLength="${spec.noteFrames}" Groove="${spec.noteFrames}" GroovePaddingMode="Middle"`,
  );
  for (const ch of ["S1", "S2", "TR", "NO"]) {
    lines.push(
      ...emitChannel(ch, spec.channels[ch] || [], spec.patternLength, spec.noteFrames, totalPatterns, spec.swing),
    );
  }
  return lines.join("\n") + "\n";
}

async function runFamiStudio(
  input: string,
  output: string,
  rate: number,
  bitrate: number,
  duration: number | undefined,
  ctx: Ctx,
): Promise<void> {
  const dll = "/usr/share/famistudio/FamiStudio.dll";
  const args = fs.existsSync(dll) ? [dll, input, "mp3-export", output] : [input, "mp3-export", output];
  args.push(`-mp3-export-rate:${rate}`, `-mp3-export-bitrate:${bitrate}`);
  if (duration != null && duration > 0) args.push(`-mp3-export-duration:${duration}`);
  if (fs.existsSync(dll)) await exec("dotnet", args, { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
  else await exec("famistudio", args, { signal: ctx.signal, timeoutMs: 5 * 60 * 1000 });
}

/** Two-pass loudnorm into the final audio format (no video). */
async function loudnormToFormat(
  input: string,
  output: string,
  format: MediaFormat,
  opts: { lufs: number; tp: number; lra: number; sampleRate: number; bitrate: number; signal?: AbortSignal },
): Promise<void> {
  if (format === "mp4") fail("generate bgm does not support mp4; use -f mp3|wav|aac");

  // First pass measure
  const measureLog = await ffmpeg(
    [
      "-i",
      input,
      "-af",
      `loudnorm=I=${opts.lufs}:TP=${opts.tp}:LRA=${opts.lra}:print_format=json`,
      "-f",
      "null",
      "-",
    ],
    { signal: opts.signal },
  );
  const start = measureLog.lastIndexOf("{");
  const end = measureLog.lastIndexOf("}");
  if (start < 0 || end <= start) fail("could not find loudnorm first-pass JSON for bgm");
  const m = JSON.parse(measureLog.slice(start, end + 1)) as Record<string, string>;
  for (const key of ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]) {
    if (typeof m[key] !== "string") fail(`loudnorm JSON missing field: ${key}`);
  }

  const filter =
    [
      `loudnorm=I=${opts.lufs}:TP=${opts.tp}:LRA=${opts.lra}`,
      `measured_I=${m.input_i}`,
      `measured_TP=${m.input_tp}`,
      `measured_LRA=${m.input_lra}`,
      `measured_thresh=${m.input_thresh}`,
      `offset=${m.target_offset}`,
      "linear=true",
      "print_format=summary",
    ].join(":") + `,aresample=${opts.sampleRate}`;

  const encode =
    format === "wav"
      ? ["-c:a", "pcm_s16le", "-ar", String(opts.sampleRate), "-ac", "2"]
      : format === "aac"
        ? ["-c:a", "aac", "-b:a", `${opts.bitrate}k`, "-ar", String(opts.sampleRate), "-ac", "2"]
        : ["-c:a", "libmp3lame", "-b:a", `${opts.bitrate}k`, "-ar", String(opts.sampleRate), "-ac", "2"];

  ensureDir(path.dirname(output));
  await ffmpeg(["-i", input, "-vn", "-af", filter, ...encode, output], { signal: opts.signal });
}

function rmQuiet(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}

/** Create chiptune BGM audio from compact NES-style MML. */
export async function generateBgm(p: GenerateBgmParams, ctx: Ctx): Promise<void> {
  const { input, output } = openFilterIo(ctx, p, { binaryOutput: true });
  const mat = await materializeInput(ctx, input, { ext: ".mml" });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "uvid-bgm-"));
  const textPath = path.join(workDir, "song.famistudio.txt");
  const rawPath = path.join(workDir, "raw.mp3");

  try {
    const sampleRate = p.sampleRate ?? 48000;
    if (![44100, 48000].includes(sampleRate)) {
      fail(`FamiStudio MP3 export rate must be 44100 or 48000: ${sampleRate}`);
    }
    const bitrate = p.bitrate ?? 192;
    if (![96, 112, 128, 160, 192, 224, 256].includes(bitrate)) {
      fail(`FamiStudio MP3 bitrate unsupported: ${bitrate}`);
    }
    if (p.duration != null && p.duration <= 0) fail(`duration must be > 0: ${p.duration}`);

    const format = resolveFormat({
      format: p.format,
      outputPath: output.path,
      defaultFormat: "mp3",
    });
    if (format === "mp4") fail("generate bgm does not support mp4; use -f mp3|wav|aac");

    const lufs = p.lufs ?? -42;
    const tp = p.tp ?? -9;
    const lra = p.lra ?? 11;

    const mml = fs.readFileSync(mat.path, "utf8");
    const spec = parseMml(mml);
    const text = emitFamiStudioText(spec);
    fs.writeFileSync(textPath, text);

    const outPath = output.path ?? path.join(workDir, `out${formatExt(format)}`);
    if (output.path) ensureDir(path.dirname(outPath));

    ctx.log(`generate bgm ${input.label} → ${output.path ? rel(ctx, output.path) : "stdout"}`);
    ctx.log(
      `  title=${spec.title}  tempo≈${spec.tempo}bpm  noteFrames=${spec.noteFrames}  swing=${spec.swing}  ar=${sampleRate}  br=${bitrate}k  format=${format}` +
        (p.duration != null ? `  duration=${p.duration}s` : ""),
    );
    if (spec.generated.length > 0) {
      ctx.log(
        `  accompaniment: style=${spec.style} s2mode=${spec.s2mode} bass=${spec.bass} progression=${spec.progressionBars} bars → ${spec.generated.join(", ")}`,
      );
    }

    ctx.log("  pass 1: FamiStudio mp3-export");
    await runFamiStudio(textPath, rawPath, sampleRate, bitrate, p.duration, ctx);
    if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) {
      fail("FamiStudio produced empty BGM export");
    }

    ctx.log(`  pass 2: loudnorm I=${lufs} LUFS TP=${tp} dBTP LRA=${lra} → ${format}`);
    await loudnormToFormat(rawPath, outPath, format, {
      lufs,
      tp,
      lra,
      sampleRate,
      bitrate,
      signal: ctx.signal,
    });

    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
      fail("generate bgm produced empty output");
    }

    if (output.path) {
      ctx.log(`wrote ${rel(ctx, output.path)}`);
    } else {
      publishFileOutput(ctx, output, outPath);
    }
  } finally {
    mat.cleanup();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      rmQuiet(textPath);
      rmQuiet(rawPath);
    }
  }
}
