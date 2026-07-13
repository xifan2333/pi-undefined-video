/**
 * uvid generate edit — ASR JSON(s) → upsert source(s) into edit.json.
 *
 * Atomic: no script.md parse, no cache layout scan.
 * Parallel multi-args must be equal length:
 *   --id / --type / --media / -i  (and optional --visual)
 * Single values are length-1 lists.
 * Re-run preserves each source's actions and other sources on -o.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveOutput, writeJsonOutput } from "../io.ts";
import { type Ctx, fail, readJson, resolvePath } from "../util.ts";

export interface GenerateEditParams {
  /** One ASR path, or equal-length list with --id/--type/--media. */
  input?: string | string[];
  output?: string;
  /** Source id(s). */
  id: string | string[];
  /** audio|video, or equal-length list. */
  type: string | string[];
  /** Media path(s). */
  media: string | string[];
  /**
   * Optional still path(s). If set, length must match.
   * Use "-" for no visual on that slot.
   */
  visual?: string | string[];
  script?: string;
  title?: string;
  status?: string;
}

const STATUS_SET = new Set(["subtitle-draft", "audio-reviewed", "video-reviewed", "ready"]);

interface AsrWord {
  text?: string;
  startMs?: number;
  endMs?: number;
  start?: number;
  end?: number;
}

interface AsrTurn {
  text?: string;
  startMs?: number;
  endMs?: number;
  start?: number;
  end?: number;
  words?: AsrWord[];
}

export interface EditWord {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface EditTurn {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  words: EditWord[];
}

export interface EditSource {
  id: string;
  type: "audio" | "video";
  media: string;
  asr: string;
  visual?: string;
  transcript: EditTurn[];
  actions: unknown[];
}

interface SourceJob {
  id: string;
  type: "audio" | "video";
  mediaGiven: string;
  asrGiven: string;
  visualGiven?: string;
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function toMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  }
  return undefined;
}

function storePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Prefer caller's relative path string so edit.json stays portable. */
function pathForEdit(ctx: Ctx, given: string, absResolved: string): string {
  if (!path.isAbsolute(given)) return storePath(given);
  const r = path.relative(ctx.cwd, absResolved).split(path.sep).join("/");
  if (r && !r.startsWith("..")) return r;
  return storePath(given);
}

/**
 * Normalize scalar | array | comma-string into a list.
 * Keeps empty slots only when keepEmpty (for visual placeholders after split elsewhere).
 */
function asList(v: unknown, label: string, opts: { required?: boolean; keepEmpty?: boolean } = {}): string[] {
  if (v === undefined || v === null) {
    if (opts.required) fail(`${label} is required`);
    return [];
  }
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : [String(v)];
  const out: string[] = [];
  for (const item of raw) {
    // Allow CLI array accumulation that already split commas.
    // If a single element still contains commas and we have only one slot intent,
    // leave as-is (CLI already splits). Do not re-split here.
    const s = item.trim();
    if (!s && !opts.keepEmpty) continue;
    out.push(s);
  }
  if (opts.required && out.length === 0) fail(`${label} is required`);
  return out;
}

function loadAsrTurns(asrPath: string): AsrTurn[] {
  const raw = readJson(asrPath);
  if (Array.isArray(raw)) return raw as AsrTurn[];
  if (raw && typeof raw === "object") {
    for (const key of ["segments", "turns", "utterances", "items"]) {
      if (Array.isArray((raw as any)[key])) return (raw as any)[key] as AsrTurn[];
    }
  }
  fail(`unsupported ASR JSON shape: ${asrPath} (expect array of {text,startMs,endMs,words?})`);
}

function buildTranscript(sourceId: string, asrPath: string): EditTurn[] {
  const turns = loadAsrTurns(asrPath);
  return turns.map((t, ti) => {
    const startMs = toMs(t.startMs ?? t.start);
    const endMs = toMs(t.endMs ?? t.end);
    if (startMs === undefined || endMs === undefined) {
      fail(`ASR turn missing start/end ms in ${asrPath} index ${ti}`);
    }
    if (endMs < startMs) fail(`ASR turn endMs < startMs in ${asrPath} index ${ti}`);
    const text = typeof t.text === "string" ? t.text : "";
    const wordsIn = Array.isArray(t.words) ? t.words : [];
    const words: EditWord[] = [];
    for (let wi = 0; wi < wordsIn.length; wi++) {
      const w = wordsIn[wi];
      const ws = toMs(w.startMs ?? w.start);
      const we = toMs(w.endMs ?? w.end);
      if (ws === undefined || we === undefined) {
        fail(`ASR word missing start/end ms in ${asrPath} turn ${ti} word ${wi}`);
      }
      words.push({
        id: `s${sourceId}-t${pad3(ti)}-w${pad3(wi)}`,
        text: typeof w.text === "string" ? w.text : "",
        startMs: ws,
        endMs: we,
      });
    }
    return {
      id: `s${sourceId}-t${pad3(ti)}`,
      text,
      startMs,
      endMs,
      words,
    };
  });
}

function loadExistingEdit(outputPath: string | null): any | null {
  if (!outputPath || !fs.existsSync(outputPath)) return null;
  try {
    const prev = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (prev && typeof prev === "object") return prev;
  } catch {
    /* ignore broken previous file */
  }
  return null;
}

function requireExistingFile(ctx: Ctx, given: string, label: string): string {
  const abs = resolvePath(ctx, given);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`${label} does not exist: ${given}`);
  return abs;
}

function parseJobs(p: GenerateEditParams): SourceJob[] {
  const ids = asList(p.id, "id", { required: true });
  const types = asList(p.type, "type", { required: true });
  const medias = asList(p.media, "media", { required: true });
  const asrs = asList(p.input, "input (-i ASR)", { required: true });
  const visuals = asList(p.visual, "visual");

  const n = ids.length;
  const lens: Record<string, number> = {
    id: ids.length,
    type: types.length,
    media: medias.length,
    input: asrs.length,
  };
  if (visuals.length) lens.visual = visuals.length;

  for (const [k, len] of Object.entries(lens)) {
    if (len !== n) {
      fail(
        `parallel args must be equal length: expected ${n} (from --id), got ${k}=${len} ` +
          `(id=${ids.length} type=${types.length} media=${medias.length} input=${asrs.length}` +
          (visuals.length ? ` visual=${visuals.length}` : "") +
          `)`,
      );
    }
  }

  const jobs: SourceJob[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`invalid id[${i}]: ${id} (use letters, digits, _ or -)`);
    if (seen.has(id)) fail(`duplicate id in this invocation: ${id}`);
    seen.add(id);

    const typeRaw = types[i].toLowerCase();
    if (typeRaw !== "audio" && typeRaw !== "video") {
      fail(`type[${i}] must be audio|video, got: ${types[i]}`);
    }

    let visualGiven: string | undefined;
    if (visuals.length) {
      const v = visuals[i];
      if (v && v !== "-" && v !== ".") visualGiven = v;
    }

    jobs.push({
      id,
      type: typeRaw as "audio" | "video",
      mediaGiven: medias[i],
      asrGiven: asrs[i],
      visualGiven,
    });
  }
  return jobs;
}

function buildSource(ctx: Ctx, job: SourceJob, prevSelf: any | undefined): EditSource {
  const asrAbs = requireExistingFile(ctx, job.asrGiven, `asr for id=${job.id}`);
  const mediaAbs = requireExistingFile(ctx, job.mediaGiven, `media for id=${job.id}`);
  const transcript = buildTranscript(job.id, asrAbs);

  const next: EditSource = {
    id: job.id,
    type: job.type,
    media: pathForEdit(ctx, job.mediaGiven, mediaAbs),
    asr: pathForEdit(ctx, job.asrGiven, asrAbs),
    transcript,
    actions: Array.isArray(prevSelf?.actions) ? prevSelf.actions : [],
  };

  if (job.visualGiven) {
    const visualAbs = requireExistingFile(ctx, job.visualGiven, `visual for id=${job.id}`);
    next.visual = pathForEdit(ctx, job.visualGiven, visualAbs);
  } else if (job.type === "audio" && typeof prevSelf?.visual === "string") {
    next.visual = prevSelf.visual;
  }

  ctx.log(
    `source ${job.id} (${job.type}): ${transcript.length} turns, ${next.actions.length} preserved actions` +
      ` · media=${next.media} · asr=${next.asr}` +
      (next.visual ? ` · visual=${next.visual}` : ""),
  );
  return next;
}

export async function generateEdit(p: GenerateEditParams, ctx: Ctx): Promise<void> {
  const statusIn = (p.status || "subtitle-draft").trim();
  if (!STATUS_SET.has(statusIn)) {
    fail(`invalid status: ${statusIn} (expected ${[...STATUS_SET].join(" | ")})`);
  }

  const jobs = parseJobs(p);
  const output = resolveOutput(ctx, p.output);
  const existing = loadExistingEdit(output.path);
  const prevSources: any[] = Array.isArray(existing?.sources) ? existing.sources : [];
  const prevById = new Map<string, any>();
  for (const s of prevSources) {
    if (s?.id != null) prevById.set(String(s.id), s);
  }

  const updates = new Map<string, EditSource>();
  for (const job of jobs) {
    updates.set(job.id, buildSource(ctx, job, prevById.get(job.id)));
  }

  // Keep previous order; replace matched ids; append new ids in invocation order.
  const ordered: EditSource[] = [];
  const placed = new Set<string>();
  for (const s of prevSources) {
    if (!s || s.id == null) continue;
    const sid = String(s.id);
    if (updates.has(sid)) {
      ordered.push(updates.get(sid)!);
      placed.add(sid);
    } else {
      ordered.push(s as EditSource);
    }
  }
  for (const job of jobs) {
    if (!placed.has(job.id)) ordered.push(updates.get(job.id)!);
  }

  const payload: Record<string, unknown> = {
    kind: "uvid.edit",
    version: 0,
    status:
      typeof existing?.status === "string" && STATUS_SET.has(existing.status)
        ? existing.status
        : statusIn,
    sources: ordered,
  };

  if (typeof existing?.script === "string") payload.script = existing.script;
  else if (p.script?.trim()) payload.script = storePath(p.script.trim());

  if (typeof existing?.title === "string") payload.title = existing.title;
  else if (p.title?.trim()) payload.title = p.title.trim();

  if (existing?.pipeline && typeof existing.pipeline === "object") payload.pipeline = existing.pipeline;
  if (existing?.notes !== undefined) payload.notes = existing.notes;
  if (Array.isArray(existing?.schemaGaps)) payload.schemaGaps = existing.schemaGaps;

  writeJsonOutput(ctx, output, payload);
}
