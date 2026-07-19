/**
 * uvid generate otio — timeline.json → one OpenTimelineIO JSON (.otio).
 *
 * Target: OpenTimelineIO 0.18 / Kdenlive 26 (SerializableObject from_json).
 *
 * Frozen shape (validated with opentimelineio 0.18.1):
 *   - Clip.2 + media_references.DEFAULT_MEDIA (not legacy media_reference)
 *   - Marker.2 + comment + marked_range (Marker.1 deserializes marked_range as null)
 *   - ExternalReference.1 target_url = absolute path (no file://)
 *   - available_range = null
 *   - RationalTime value/rate as floats
 *   - Track/Stack/Clip/Gap: effects=[], markers=[], enabled=true, source_range/color as needed
 *
 * Tracks: V1 Program, V2_DIALOG (optional), A1_VOICE, A3_BGM (optional).
 * Captions → Marker.2 on V1. Only -i/-o + name/fps.
 */
import path from "node:path";
import { resolveInput, resolveOutput, writeJsonOutput } from "../io.ts";
import { type Ctx, fail, rel } from "../util.ts";

export interface GenerateOtioParams {
  input?: string;
  output?: string;
  name?: string;
  fps?: number;
}

interface TimelineSegment {
  id: string;
  role: string;
  sourceId?: string;
  media?: string | null;
  visual?: string | null;
  inMs?: number;
  outMs?: number;
  startMs: number;
  endMs: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  picture?: string;
  kind?: string;
  title?: string;
  beforeSourceId?: string;
}

interface DialogCue {
  startMs: number;
  endMs: number;
  state: string;
  turnId?: string;
  sourceId?: string;
}

interface Caption {
  startMs: number;
  endMs: number;
  text: string;
  words?: Array<{ startMs: number; endMs: number; text: string }>;
  turnId?: string;
  sourceId?: string;
}

interface TimelineBgm {
  media: string;
  durationMs?: number;
  /** Program-axis window: intro end → outro start. */
  startMs?: number;
  endMs?: number;
  loop?: boolean;
  volume?: number;
}

interface TimelineDialogSprites {
  dir: string;
  needles?: string[];
}

interface TimelineCaptionsStyle {
  burn?: boolean;
  style?: string;
  fg?: string;
  bg?: string;
  font?: string;
  fontSize?: number;
}

interface TimelineDoc {
  kind?: string;
  basis?: string;
  durationMs?: number;
  from?: { title?: string; edit?: string; status?: string; script?: string };
  packaging?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  segments?: TimelineSegment[];
  dialog?: DialogCue[];
  captions?: Caption[];
  bgm?: TimelineBgm | null;
  dialogSprites?: TimelineDialogSprites | null;
  captionsStyle?: TimelineCaptionsStyle | null;
}

type Json = Record<string, unknown>;

function rationalTime(ms: number, fps: number): Json {
  // OTIO 0.18 serializes value/rate as floats.
  const value = Math.round((Math.max(0, ms) / 1000) * fps);
  return { OTIO_SCHEMA: "RationalTime.1", rate: fps * 1.0, value: value * 1.0 };
}

function timeRange(startMs: number, endMs: number, fps: number): Json {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    start_time: rationalTime(startMs, fps),
    duration: rationalTime(Math.max(0, endMs - startMs), fps),
  };
}

/** Kdenlive wants absolute filesystem paths, not file:// URLs. */
function absPath(baseDir: string, relPath: string): string {
  return path.resolve(baseDir, relPath);
}

function composableBase(): Json {
  return {
    metadata: {},
    effects: [],
    markers: [],
    enabled: true,
  };
}

function gapItem(durMs: number, fps: number, name = "gap"): Json {
  return {
    OTIO_SCHEMA: "Gap.1",
    ...composableBase(),
    name,
    source_range: timeRange(0, durMs, fps),
    color: null,
  };
}

/** OTIO 0.18 Clip.2 — media_references map, not singular media_reference. */
function externalClip(opts: {
  name: string;
  inMs: number;
  durMs: number;
  fps: number;
  absMedia: string;
  metadata?: Json;
  markers?: Json[];
}): Json {
  return {
    OTIO_SCHEMA: "Clip.2",
    metadata: opts.metadata || {},
    name: opts.name,
    source_range: timeRange(opts.inMs, opts.inMs + opts.durMs, opts.fps),
    effects: [],
    markers: opts.markers || [],
    enabled: true,
    color: null,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        metadata: {},
        name: "",
        available_range: null,
        available_image_bounds: null,
        target_url: opts.absMedia,
      },
    },
    active_media_reference_key: "DEFAULT_MEDIA",
  };
}

function track(opts: {
  name: string;
  kind: "Video" | "Audio";
  children: Json[];
  markers?: Json[];
  metadata?: Json;
}): Json {
  return {
    OTIO_SCHEMA: "Track.1",
    metadata: opts.metadata || {},
    name: opts.name,
    source_range: null,
    effects: [],
    markers: opts.markers || [],
    enabled: true,
    color: null,
    children: opts.children,
    kind: opts.kind,
  };
}

function mergeDialogCues(cues: DialogCue[]): DialogCue[] {
  const out: DialogCue[] = [];
  for (const c of cues) {
    const startMs = Math.trunc(c.startMs);
    const endMs = Math.trunc(c.endMs);
    if (endMs <= startMs) continue;
    const last = out[out.length - 1];
    if (last && last.state === c.state && last.endMs === startMs) {
      last.endMs = endMs;
      continue;
    }
    out.push({
      startMs,
      endMs,
      state: c.state,
      ...(c.turnId ? { turnId: c.turnId } : {}),
      ...(c.sourceId ? { sourceId: c.sourceId } : {}),
    });
  }
  return out;
}

function buildV1(segments: TimelineSegment[], baseDir: string, fps: number): Json[] {
  const children: Json[] = [];
  for (const seg of segments) {
    const durMs = Math.max(0, Math.trunc(seg.endMs) - Math.trunc(seg.startMs));
    if (durMs <= 0) continue;
    const inMs = seg.inMs != null ? Math.trunc(seg.inMs) : 0;
    const picture =
      seg.picture ||
      (seg.role === "aroll" ? (seg.media && seg.hasVideo !== false ? "media" : "still") : "none");

    let mediaRel: string | null = null;
    if (picture === "still") mediaRel = seg.visual || null;
    else if (picture === "media") mediaRel = seg.media || seg.visual || null;
    else mediaRel = seg.media || seg.visual || null;

    if (!mediaRel) {
      children.push(gapItem(durMs, fps, seg.id || "gap"));
      continue;
    }

    children.push(
      externalClip({
        name: seg.id,
        inMs,
        durMs,
        fps,
        absMedia: absPath(baseDir, mediaRel),
        metadata: {
          uvid: {
            role: seg.role,
            sourceId: seg.sourceId ?? null,
            picture,
            kind: seg.kind ?? null,
            hasAudio: Boolean(seg.hasAudio),
            hasVideo: Boolean(seg.hasVideo),
            programStartMs: seg.startMs,
            programEndMs: seg.endMs,
            media: seg.media ?? null,
            visual: seg.visual ?? null,
          },
        },
      }),
    );
  }
  return children;
}

function buildA1(segments: TimelineSegment[], baseDir: string, fps: number): Json[] {
  const children: Json[] = [];
  for (const seg of segments) {
    const durMs = Math.max(0, Math.trunc(seg.endMs) - Math.trunc(seg.startMs));
    if (durMs <= 0) continue;
    const inMs = seg.inMs != null ? Math.trunc(seg.inMs) : 0;
    if (seg.hasAudio && seg.media) {
      children.push(
        externalClip({
          name: `${seg.id}-voice`,
          inMs,
          durMs,
          fps,
          absMedia: absPath(baseDir, seg.media),
          metadata: {
            uvid: {
              role: "voice",
              segmentId: seg.id,
              sourceId: seg.sourceId ?? null,
              programStartMs: seg.startMs,
              programEndMs: seg.endMs,
            },
          },
        }),
      );
    } else {
      children.push(gapItem(durMs, fps, `${seg.id}-silence`));
    }
  }
  return children;
}

function buildV2Dialog(
  dialog: DialogCue[],
  sprites: TimelineDialogSprites | null | undefined,
  durationMs: number,
  baseDir: string,
  fps: number,
): Json[] | null {
  if (!dialog.length || !sprites?.dir) return null;
  const merged = mergeDialogCues(dialog);
  if (!merged.length) return null;

  const children: Json[] = [];
  let cursor = 0;
  for (const cue of merged) {
    if (cue.startMs > cursor) children.push(gapItem(cue.startMs - cursor, fps));
    const s = Math.max(cursor, cue.startMs);
    const e = Math.max(s, cue.endMs);
    const dur = e - s;
    if (dur <= 0) continue;

    if (cue.state === "hidden") {
      children.push(gapItem(dur, fps, "dialog-hidden"));
    } else {
      const needle = path.join(sprites.dir, `${cue.state}.png`);
      children.push(
        externalClip({
          name: `dialog-${cue.state}`,
          inMs: 0,
          durMs: dur,
          fps,
          absMedia: absPath(baseDir, needle),
          metadata: {
            uvid: {
              kind: "dialog",
              state: cue.state,
              programStartMs: s,
              programEndMs: e,
              turnId: cue.turnId ?? null,
              sourceId: cue.sourceId ?? null,
              spritesDir: sprites.dir,
            },
          },
        }),
      );
    }
    cursor = e;
  }
  if (cursor < durationMs) children.push(gapItem(durationMs - cursor, fps));
  return children;
}

/**
 * A3 BGM — only inside [startMs, endMs) = intro end → outro start.
 * Leading/trailing gaps keep intro/outro free of the bed.
 */
function buildA3Bgm(
  bgm: TimelineBgm | null | undefined,
  durationMs: number,
  baseDir: string,
  fps: number,
): Json[] | null {
  if (!bgm?.media || durationMs <= 0) return null;
  const bedMs = Math.max(1, Math.trunc(bgm.durationMs || durationMs));
  const loop = bgm.loop !== false;
  const volume = bgm.volume != null && Number.isFinite(bgm.volume) ? Number(bgm.volume) : 0.3;
  const startMs =
    bgm.startMs != null && Number.isFinite(bgm.startMs)
      ? Math.max(0, Math.min(durationMs, Math.trunc(bgm.startMs)))
      : 0;
  const endMs =
    bgm.endMs != null && Number.isFinite(bgm.endMs)
      ? Math.max(startMs, Math.min(durationMs, Math.trunc(bgm.endMs)))
      : durationMs;
  const winMs = endMs - startMs;
  if (winMs <= 0) return null;

  const abs = absPath(baseDir, bgm.media);
  const children: Json[] = [];

  if (startMs > 0) children.push(gapItem(startMs, fps, "bgm-pre-intro"));

  const push = (name: string, takeMs: number, meta: Json) => {
    children.push(
      externalClip({
        name,
        inMs: 0,
        durMs: takeMs,
        fps,
        absMedia: abs,
        metadata: { uvid: meta },
      }),
    );
  };

  if (!loop || bedMs >= winMs) {
    push("bgm", winMs, {
      kind: "bgm",
      media: bgm.media,
      durationMs: bedMs,
      loop,
      volume,
      programStartMs: startMs,
      programEndMs: endMs,
    });
  } else {
    let t = 0;
    let i = 0;
    while (t < winMs) {
      const take = Math.min(bedMs, winMs - t);
      push(`bgm-${i}`, take, {
        kind: "bgm",
        media: bgm.media,
        durationMs: bedMs,
        loop,
        volume,
        loopIndex: i,
        programStartMs: startMs + t,
        programEndMs: startMs + t + take,
      });
      t += take;
      i += 1;
    }
  }

  if (endMs < durationMs) children.push(gapItem(durationMs - endMs, fps, "bgm-post-outro"));
  return children;
}

/**
 * Caption markers as OTIO Marker.2 (0.18).
 * Marker.1 is rejected by 0.18 deserializers (marked_range becomes None).
 */
function buildCaptionMarkers(
  captions: Caption[],
  style: TimelineCaptionsStyle | null | undefined,
  fps: number,
): Json[] {
  return captions
    .filter((c) => c.endMs > c.startMs)
    .map((c, i) => ({
      OTIO_SCHEMA: "Marker.2",
      metadata: {
        uvid: {
          kind: "caption",
          text: c.text,
          turnId: c.turnId ?? null,
          sourceId: c.sourceId ?? null,
          words: Array.isArray(c.words) ? c.words.length : 0,
          style: style || null,
        },
      },
      name: c.turnId || `caption-${i}`,
      color: "PINK",
      marked_range: timeRange(c.startMs, c.endMs, fps),
      comment: c.text || "",
    }));
}

export async function generateOtio(p: GenerateOtioParams, ctx: Ctx): Promise<void> {
  const input = resolveInput(ctx, p.input, "timeline.json");
  const output = resolveOutput(ctx, p.output);
  const { readInputJson } = await import("../io.ts");
  const raw = await readInputJson(ctx, input);
  if (!raw || typeof raw !== "object") fail("timeline.json must be an object");
  const tl = raw as TimelineDoc;
  if (tl.kind && tl.kind !== "uvid.timeline") fail(`expected kind uvid.timeline, got ${tl.kind}`);
  const segments = tl.segments;
  if (!Array.isArray(segments) || !segments.length) fail("timeline.segments[] required");

  const fps = p.fps ?? 25;
  if (fps <= 0) fail("--fps must be > 0");

  const baseDir = path.dirname(input.path || path.join(ctx.cwd, "timeline.json"));
  const durationMs =
    tl.durationMs != null && Number.isFinite(tl.durationMs)
      ? Math.trunc(tl.durationMs)
      : Math.max(0, ...segments.map((s) => Math.trunc(s.endMs || 0)));

  const name =
    p.name ||
    tl.from?.title ||
    (output.path ? path.basename(output.path, path.extname(output.path)) : "episode");

  const v1 = buildV1(segments, baseDir, fps);
  const markers = buildCaptionMarkers(
    Array.isArray(tl.captions) ? tl.captions : [],
    tl.captionsStyle,
    fps,
  );
  const a1 = buildA1(segments, baseDir, fps);
  const v2 = buildV2Dialog(
    Array.isArray(tl.dialog) ? tl.dialog : [],
    tl.dialogSprites,
    durationMs,
    baseDir,
    fps,
  );
  const a3 = buildA3Bgm(tl.bgm, durationMs, baseDir, fps);

  // Known-good kdenlive order: V1, V2 overlay, A1 voice, A3 bgm.
  const trackChildren: Json[] = [
    track({ name: "V1", kind: "Video", children: v1, markers }),
  ];
  if (v2) {
    trackChildren.push(
      track({
        name: "V2_DIALOG",
        kind: "Video",
        children: v2,
        metadata: { uvid: { kind: "dialog-overlay", sprites: tl.dialogSprites || null } },
      }),
    );
  }
  trackChildren.push(track({ name: "A1_VOICE", kind: "Audio", children: a1 }));
  if (a3) {
    trackChildren.push(
      track({
        name: "A3_BGM",
        kind: "Audio",
        children: a3,
        metadata: {
          uvid: {
            kind: "bgm",
            media: tl.bgm?.media ?? null,
            volume: tl.bgm?.volume ?? 0.3,
            loop: tl.bgm?.loop !== false,
          },
        },
      }),
    );
  }

  const otio = {
    OTIO_SCHEMA: "Timeline.1",
    metadata: {
      uvid: {
        from: tl.from || {},
        basis: tl.basis,
        durationMs,
        packaging: tl.packaging || null,
        dialogSprites: tl.dialogSprites || null,
        bgm: tl.bgm || null,
        captionsStyle: tl.captionsStyle || null,
        dialogCues: Array.isArray(tl.dialog) ? tl.dialog.length : 0,
        captions: Array.isArray(tl.captions) ? tl.captions.length : 0,
        exporter: "uvid generate otio",
        otioSchema: "0.18",
      },
    },
    name,
    global_start_time: rationalTime(0, fps),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      metadata: {},
      name: "tracks",
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      color: null,
      children: trackChildren,
    },
  };

  writeJsonOutput(ctx, output, otio);
  ctx.log(
    `otio tracks=${trackChildren.length} V1=${v1.length}` +
      (v2 ? ` V2=${v2.length}` : "") +
      ` A1=${a1.length}` +
      (a3 ? ` A3=${a3.length}` : "") +
      ` markers=${markers.length} fps=${fps}` +
      (output.path ? ` → ${rel(ctx, output.path)}` : ""),
  );
}
