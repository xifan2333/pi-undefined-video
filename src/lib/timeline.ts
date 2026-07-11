/**
 * Timeline commands: derive the post-cut main timeline from script.md + draft.json +
 * measured assets, and export it as OTIO.
 */
import fs from "node:fs";
import path from "node:path";
import { type Ctx, ensureDir, fail, readJson, rel, resolveExisting, resolvePath, writeJson } from "./util.ts";
import { mediaDurationMs, videoFrames } from "./proc.ts";

export type ScriptChapter = {
  /** 1-based index among media-bearing `---` blocks (NOT source id). */
  index: number;
  title: string | null;
  /** true when the block has an H2 → timeline inserts toc-{index}. */
  menu: boolean;
  mediaTag: string | null;
  sourceId: string | null;
  sourcePath: string | null;
};

export type ParsedScript = {
  fps: number;
  title: string | null;
  theme: string | null;
  chapters: ScriptChapter[];
};

/**
 * Parse episode script for finish/timeline.
 *
 * Rules (contract):
 * - Frontmatter must define `fps`.
 * - Split body on `---` horizontal rules; only blocks that contain
 *   `<video src>` / `<audio src>` become chapters.
 * - Chapter `index` = order among those blocks, 1-based, zero-padded as NN.
 * - H2 title → menu chapter → timeline expects `clips/toc-NN.mp4` where NN = chapter index.
 * - No H2 → still a chapter (voice + visual) but no TOC card.
 * - H3+ never create chapters or TOC entries.
 * - Source id = basename of media src without extension (e.g. raw/04.mp4 → 04).
 *   TOC file name uses chapter index, which often equals source id under the
 *   usual NN naming, but they are different fields.
 */
export function parseScriptMarkdown(scriptPath: string): ParsedScript {
  const md = fs.readFileSync(scriptPath, "utf8");
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = fmMatch ? fmMatch[1] : "";
  const fps = Number.parseInt((fm.match(/^fps:\s*(\d+)/m) || [])[1], 10);
  if (!Number.isFinite(fps) || fps <= 0) fail("script frontmatter must define fps");
  const theme = (fm.match(/^theme:\s*(.+?)\s*$/m) || [])[1] || null;
  const body = fmMatch ? md.slice(fmMatch[0].length) : md;

  // H1 = video title (frontmatter `title:` wins if present). H2 = TOC chapters.
  // H3+ = plain content inside a chapter's markdown scenes, never chapters.
  const fmTitle = (fm.match(/^title:\s*(.+?)\s*$/m) || [])[1] || null;
  const bodyH1 = (body.match(/^#\s+(.+?)\s*$/m) || [])[1] || null;
  const title = fmTitle || bodyH1;

  const chapters: ScriptChapter[] = [];
  for (const block of body.split(/^---\s*$/m)) {
    if (!/<(video|audio)\s+src="[^"]+"/.test(block)) continue;
    // H2 = chapter title (enters TOC). No H2 = untitled chapter, skipped by TOC.
    const h2 = block.match(/^##\s+(.+?)\s*$/m);
    const media = block.match(/<(video|audio)\s+src="([^"]+)"/);
    chapters.push({
      index: chapters.length + 1,
      title: h2 ? h2[1].trim() : null,
      menu: Boolean(h2),
      mediaTag: media ? media[1] : null,
      sourceId: media ? path.basename(media[2]).replace(/\.\w+$/, "") : null,
      sourcePath: media ? media[2] : null,
    });
  }
  return { fps, title, theme, chapters };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function tocIdForChapter(chapterIndex: number): string {
  return `toc-${pad2(chapterIndex)}`;
}

export interface TimelinePlanParams {
  script: string;
  /** Optional: when set, plan reports which expected files already exist. */
  clipsDir?: string;
  voiceDir?: string;
  scenesDir?: string;
  draft?: string;
  /** Write plan JSON here; when omitted, print to log. */
  output?: string;
}

/**
 * Dry-run the finish/timeline asset contract from script.md (and optional dirs).
 * Agent should call this before creating toc scenes so it knows how many TOCs,
 * their ids, and the exact finish scene params — no chicken-and-egg missing-clip.
 */
export async function timelinePlan(p: TimelinePlanParams, ctx: Ctx): Promise<void> {
  const scriptPath = resolveExisting(ctx, p.script, "--script");
  const { fps, title, theme, chapters } = parseScriptMarkdown(scriptPath);

  const menuChapters = chapters.filter((c) => c.menu && c.title);
  const menuTitles = menuChapters.map((c) => c.title as string);

  const toc: any[] = [];
  let menuOrdinal = 0;
  for (const ch of chapters) {
    if (!ch.menu) continue;
    const currentIndex = menuOrdinal;
    const previousIndex = menuOrdinal === 0 ? 0 : menuOrdinal - 1;
    const id = tocIdForChapter(ch.index);
    toc.push({
      id,
      chapterIndex: ch.index,
      sourceId: ch.sourceId,
      title: ch.title,
      // 0-based index into chaptersJson (menu titles only)
      currentIndex,
      previousIndex,
      expectedClip: `${id}.mp4`,
      sceneParams: {
        type: "toc",
        id,
        duration: 4,
        chaptersJson: menuTitles,
        currentIndex,
        previousIndex,
      },
    });
    menuOrdinal += 1;
  }

  const sceneOrder: any[] = [{ type: "intro", id: "intro", expectedClip: "intro.mp4" }];
  for (const ch of chapters) {
    if (ch.menu) {
      sceneOrder.push({
        type: "toc",
        id: tocIdForChapter(ch.index),
        chapterIndex: ch.index,
        sourceId: ch.sourceId,
        expectedClip: `${tocIdForChapter(ch.index)}.mp4`,
      });
    }
    const kind = ch.mediaTag === "video" ? "video" : "markdown";
    sceneOrder.push({
      type: kind,
      chapterIndex: ch.index,
      sourceId: ch.sourceId,
      expectedVoice: ch.sourceId ? `src-${ch.sourceId}.wav` : null,
      expectedVisual:
        kind === "video"
          ? null // comes from draft source.path
          : ch.sourceId
            ? `screen-${ch.sourceId}-01.png`
            : null,
    });
  }
  sceneOrder.push({ type: "outro", id: "outro", expectedClip: "outro.mp4" });

  const requiredClips = [
    "intro.mp4",
    ...toc.map((t) => t.expectedClip),
    "outro.mp4",
  ];
  const requiredVoices = chapters
    .map((c) => (c.sourceId ? `src-${c.sourceId}.wav` : null))
    .filter(Boolean) as string[];
  const requiredStills = chapters
    .filter((c) => c.mediaTag === "audio" && c.sourceId)
    .map((c) => `screen-${c.sourceId}-01.png`);

  const checkDir = (dir: string | undefined, names: string[]) => {
    if (!dir) return names.map((name) => ({ name, exists: null as boolean | null }));
    const abs = resolveExisting(ctx, dir, "dir");
    return names.map((name) => ({ name, exists: fs.existsSync(path.join(abs, name)) }));
  };

  const clipStatus = checkDir(p.clipsDir, requiredClips);
  const voiceStatus = checkDir(p.voiceDir, requiredVoices);
  const stillStatus = checkDir(p.scenesDir ?? p.clipsDir, requiredStills);

  const missing = [
    ...clipStatus.filter((x) => x.exists === false).map((x) => `clip:${x.name}`),
    ...voiceStatus.filter((x) => x.exists === false).map((x) => `voice:${x.name}`),
    ...stillStatus.filter((x) => x.exists === false).map((x) => `still:${x.name}`),
  ];

  const plan = {
    schemaVersion: 1,
    kind: "finish.plan",
    script: rel(ctx, scriptPath),
    fps,
    title,
    theme,
    rules: [
      "Only media-bearing --- blocks become chapters; H3 never creates TOC.",
      "TOC id = toc-{chapterIndex} (1-based order of media blocks), not source id (often equal under NN naming).",
      "Menu list for toc scenes = H2 titles only, in order; currentIndex is 0-based into that list.",
      "timeline expects clips/{intro,toc-NN,outro}.mp4 and voiceDir/src-{sourceId}.wav before finish timeline.",
      "Call finish plan before creating toc scenes; do not invent toc ids.",
    ],
    chapters: chapters.map((c) => ({
      index: c.index,
      title: c.title,
      menu: c.menu,
      mediaTag: c.mediaTag,
      sourceId: c.sourceId,
      sourcePath: c.sourcePath,
      tocId: c.menu ? tocIdForChapter(c.index) : null,
    })),
    menuTitles,
    toc,
    sceneOrder,
    required: {
      clips: requiredClips,
      voices: requiredVoices,
      stills: requiredStills,
    },
    status: {
      clips: clipStatus,
      voices: voiceStatus,
      stills: stillStatus,
      missing,
    },
  };

  if (p.output) {
    const out = resolvePath(ctx, p.output);
    writeJson(out, plan);
    ctx.log(`uvid finish plan: wrote ${rel(ctx, out)}`);
  } else {
    ctx.log(JSON.stringify(plan, null, 2));
  }

  ctx.log(`  chapters=${chapters.length} menu/toc=${toc.length} title=${title ?? "(none)"}`);
  for (const t of toc) {
    ctx.log(
      `  TOC ${t.id}  chapterIndex=${t.chapterIndex} sourceId=${t.sourceId} currentIndex=${t.currentIndex} "${t.title}"`,
    );
  }
  if (missing.length) {
    ctx.log(`  missing (${missing.length}): ${missing.join(", ")}`);
  } else if (p.clipsDir || p.voiceDir) {
    ctx.log("  all checked required assets present");
  } else {
    ctx.log("  tip: pass clipsDir/voiceDir to see which expected files already exist");
  }
}

export interface TimelineMainParams {
  script: string;
  draft: string;
  clipsDir: string;
  scenesDir: string;
  voiceDir: string;
  output: string;
  introSfx?: string;
  introSfxOffset?: number;
  tocSfx?: string;
  outroSfx?: string;
  bgm?: string;
  dialogOpenArrow?: string;
  dialogClosedArrow?: string;
  dialogOpenNoarrow?: string;
  dialogClosedNoarrow?: string;
}

/** Derive build/timeline.json (single time base) from decisions + measured assets. */
export async function timelineCreateMain(p: TimelineMainParams, ctx: Ctx): Promise<void> {
  const scriptPath = resolveExisting(ctx, p.script, "--script");
  const editPath = resolveExisting(ctx, p.draft, "--draft");
  const clipsDir = resolveExisting(ctx, p.clipsDir, "--clips-dir");
  const scenesDir = resolveExisting(ctx, p.scenesDir, "--scenes-dir");
  const voiceDir = resolveExisting(ctx, p.voiceDir, "--voice-dir");
  const output = resolvePath(ctx, p.output);
  const optional = (label: string, v?: string): string | null => (v ? resolveExisting(ctx, v, label) : null);
  const introSfx = optional("--intro-sfx", p.introSfx);
  const tocSfx = optional("--toc-sfx", p.tocSfx);
  const outroSfx = optional("--outro-sfx", p.outroSfx);
  const bgm = optional("--bgm", p.bgm);
  const dialogOpenArrow = optional("--dialog-open-arrow", p.dialogOpenArrow);
  const dialogClosedArrow = optional("--dialog-closed-arrow", p.dialogClosedArrow);
  const dialogOpenNoarrow = optional("--dialog-open-noarrow", p.dialogOpenNoarrow);
  const dialogClosedNoarrow = optional("--dialog-closed-noarrow", p.dialogClosedNoarrow);

  const { fps, title, chapters } = parseScriptMarkdown(scriptPath);
  const edit = readJson(editPath);
  const editDir = path.dirname(editPath);
  const sources = Object.fromEntries((edit.sources || []).map((s: any) => [s.id, s]));
  const frameMs = 1000 / fps;
  const toFrames = (ms: number) => Math.ceil(ms / frameMs - 1e-6);
  const outRel = (pth: string) => path.relative(path.dirname(output), pth).replace(/\\/g, "/");

  async function voiceWav(id: string): Promise<any> {
    const pth = path.join(voiceDir, `src-${id}.wav`);
    if (!fs.existsSync(pth)) fail(`missing voice premix: ${pth}`);
    return { path: outRel(pth), durationMs: await mediaDurationMs(pth, ctx) };
  }
  async function clipScene(id: string, type: string, extra: any = {}): Promise<any> {
    const pth = path.join(clipsDir, `${id}.mp4`);
    if (!fs.existsSync(pth)) {
      const menuIds = chapters
        .filter((c: any) => c.menu)
        .map((c: any) => `toc-${String(c.index).padStart(2, "0")}.mp4`);
      fail(
        `missing clip: ${pth}\n` +
          `  finish timeline expects these scene clips in ${rel(ctx, clipsDir)}:\n` +
          `    intro.mp4, ${menuIds.join(", ") || "(no toc)"}, outro.mp4\n` +
          `  TOC id = toc-{chapterIndex} (1-based media-block order), not invented names.\n` +
          `  Run: uvid finish plan --script <script.md> --clips-dir ${rel(ctx, clipsDir)}`,
      );
    }
    return { id, type, visual: outRel(pth), durationFrames: await videoFrames(pth, fps, ctx), ...extra };
  }
  function videoSceneInfo(src: any): any {
    let durMs = 0;
    const ranges: any[] = [];
    for (let i = 0; i < src.ranges.length; i++) {
      const r = src.ranges[i];
      const len = r.sourceEndMs - r.sourceStartMs;
      let holdAfterMs = 0;
      const next = src.ranges[i + 1];
      if (next) {
        const sm = (r.out && r.out.smoothing) || (next.in && next.in.smoothing) || null;
        if (sm && sm.type === "breath_gap") holdAfterMs = sm.ms;
        else if (sm && sm.type === "crossfade") holdAfterMs = -sm.ms;
      }
      durMs += len + Math.max(holdAfterMs, 0);
      ranges.push({ id: r.id, sourceStartMs: r.sourceStartMs, sourceEndMs: r.sourceEndMs, holdAfterMs: Math.max(holdAfterMs, 0) });
    }
    return { ranges, durMs };
  }

  const scenes: any[] = [];
  scenes.push(await clipScene("intro", "intro"));
  for (const ch of chapters) {
    if (ch.menu) scenes.push(await clipScene(`toc-${String(ch.index).padStart(2, "0")}`, "toc", { chapterIndex: ch.index }));
    const src = sources[ch.sourceId];
    if (!src) fail(`edit source not found for chapter ${ch.index}: ${ch.sourceId}`);
    const vw = await voiceWav(src.id);
    if (src.kind === "video") {
      const info = videoSceneInfo(src);
      scenes.push({
        id: `video-${src.id}`,
        type: "video",
        chapterIndex: ch.index,
        visual: outRel(path.resolve(editDir, src.path)),
        sourceRanges: info.ranges,
        durationFrames: toFrames(vw.durationMs),
        voice: vw,
      });
    } else {
      const visual = path.join(scenesDir, `screen-${src.id}-01.png`);
      scenes.push({
        id: `screen-${src.id}-01`,
        type: "markdown",
        chapterIndex: ch.index,
        visual: outRel(visual),
        durationFrames: toFrames(vw.durationMs),
        voice: vw,
      });
    }
  }
  scenes.push(await clipScene("outro", "outro"));

  let cursor = 0;
  for (const s of scenes) {
    s.timelineStartFrame = cursor;
    s.timelineStartMs = Math.round(cursor * frameMs);
    s.durationMs = Math.round(s.durationFrames * frameMs);
    if (s.voice) {
      s.voice.offsetFrame = cursor;
      s.voice.offsetMs = s.timelineStartMs;
    }
    cursor += s.durationFrames;
  }

  const msToFrame = (ms: number) => Math.round(ms / frameMs);
  const v1Clips = scenes.map((s: any) => {
    const clip: any = {
      id: s.id,
      sceneId: s.id,
      source: s.visual,
      timelineStartFrame: s.timelineStartFrame,
      durationFrames: s.durationFrames,
    };
    if (s.type === "markdown") clip.mode = "still";
    if (s.type === "video") {
      clip.sourceRanges = (s.sourceRanges || []).map((r: any) => ({
        id: r.id,
        sourceStartFrame: msToFrame(r.sourceStartMs),
        sourceEndFrame: msToFrame(r.sourceEndMs),
        durationFrames: msToFrame(r.sourceEndMs - r.sourceStartMs),
        holdAfterFrames: msToFrame(r.holdAfterMs || 0),
        sourceStartMs: r.sourceStartMs,
        sourceEndMs: r.sourceEndMs,
        holdAfterMs: r.holdAfterMs || 0,
      }));
      clip.compound = true;
    }
    return clip;
  });
  const voiceClips = scenes.filter((s: any) => s.voice).map((s: any) => ({
    id: `voice-${s.id}`,
    sceneId: s.id,
    source: s.voice.path,
    timelineStartFrame: s.voice.offsetFrame,
    durationFrames: s.durationFrames,
    sourceStartFrame: 0,
  }));

  const sfxClips: any[] = [];
  if (introSfx) {
    const offsetFrames = p.introSfxOffset ? Math.round(p.introSfxOffset * fps) : 0;
    if (!Number.isFinite(offsetFrames) || offsetFrames < 0) fail(`invalid --intro-sfx-offset: ${p.introSfxOffset}`);
    sfxClips.push({
      id: "sfx-intro",
      source: outRel(introSfx),
      timelineStartFrame: offsetFrames,
      durationFrames: toFrames(await mediaDurationMs(introSfx, ctx)),
      sourceStartFrame: 0,
    });
  }
  if (tocSfx) {
    const dur = toFrames(await mediaDurationMs(tocSfx, ctx));
    for (const s of scenes.filter((x: any) => x.type === "toc")) {
      sfxClips.push({
        id: `sfx-${s.id}`,
        sceneId: s.id,
        source: outRel(tocSfx),
        timelineStartFrame: s.timelineStartFrame,
        durationFrames: dur,
        sourceStartFrame: 0,
      });
    }
  }
  if (outroSfx) {
    const outro = scenes.find((s: any) => s.type === "outro");
    if (!outro) fail("cannot place --outro-sfx: no outro scene");
    sfxClips.push({
      id: "sfx-outro",
      sceneId: outro.id,
      source: outRel(outroSfx),
      timelineStartFrame: outro.timelineStartFrame,
      durationFrames: toFrames(await mediaDurationMs(outroSfx, ctx)),
      sourceStartFrame: 0,
    });
  }

  const bgmClips: any[] = [];
  if (bgm) {
    const intro = scenes.find((s: any) => s.type === "intro");
    const outro = scenes.find((s: any) => s.type === "outro");
    if (!intro || !outro) fail("cannot place --bgm: intro/outro scenes required");
    const start = intro.timelineStartFrame + intro.durationFrames;
    const duration = Math.max(0, outro.timelineStartFrame - start);
    bgmClips.push({
      id: "bgm-main",
      source: outRel(bgm),
      timelineStartFrame: start,
      durationFrames: duration,
      sourceStartFrame: 0,
    });
  }

  const dialogAssets = { dialogOpenArrow, dialogClosedArrow, dialogOpenNoarrow, dialogClosedNoarrow };
  const hasSomeDialogAsset = Object.values(dialogAssets).some(Boolean);
  const hasAllDialogAssets = Object.values(dialogAssets).every(Boolean);
  if (hasSomeDialogAsset && !hasAllDialogAssets) fail("dialog overlay requires all four --dialog-* PNGs");
  const dialogClips: any[] = [];
  const subtitles: any[] = [];
  if (hasAllDialogAssets) {
    const bySource = new Map(scenes.filter((s: any) => s.voice).map((s: any) => {
      const m = String(s.voice.path).match(/src-([^/.]+)\.wav$/);
      return [m ? m[1] : null, s];
    }).filter(([id]: any[]) => id));
    const fpsFromMs = (ms: number) => Math.max(1, Math.round(ms / frameMs));
    let n = 0;
    const addDialogClip = (id: string, source: string, start: number, dur: number) => {
      if (dur <= 0) return;
      dialogClips.push({ id, source: outRel(source), timelineStartFrame: start, durationFrames: dur, sourceStartFrame: 0, mode: "still" });
    };
    for (const src of edit.sources || []) {
      const scene = bySource.get(src.id);
      if (!scene) continue;
      for (const sub of src.subtitles || []) {
        const start = scene.timelineStartFrame + fpsFromMs(sub.sourceLocalStartMs || 0);
        const end = scene.timelineStartFrame + fpsFromMs(sub.sourceLocalEndMs || 0);
        const dur = Math.max(1, end - start);
        const talk = Math.max(1, Math.round(dur * 0.7));
        const wait = Math.max(0, dur - talk);
        subtitles.push({ id: sub.id, source: src.id, text: sub.text, startFrame: start, durationFrames: dur, talkFrames: talk, waitFrames: wait });
        let cursorFrame = start;
        // talk: alternate open/closed no-arrow. Runtime state duration is 1/8s (8Hz mouth state switch).
        const mouthStep = Math.max(1, Math.round(fps / 8));
        let mouthOpen = true;
        while (cursorFrame < start + talk) {
          const d = Math.min(mouthStep, start + talk - cursorFrame);
          addDialogClip(`dialog-${String(n++).padStart(5, "0")}-${mouthOpen ? "open" : "closed"}`, mouthOpen ? dialogOpenNoarrow! : dialogClosedNoarrow!, cursorFrame, d);
          cursorFrame += d;
          mouthOpen = !mouthOpen;
        }
        // wait: closed arrow/no-arrow blink. Runtime state duration is 1/2s (2Hz arrow state switch).
        const blink = Math.max(1, Math.round(fps / 2));
        let on = true;
        while (cursorFrame < end) {
          const d = Math.min(blink, end - cursorFrame);
          addDialogClip(`dialog-${String(n++).padStart(5, "0")}-${on ? "arrow" : "noarrow"}`, on ? dialogClosedArrow! : dialogClosedNoarrow!, cursorFrame, d);
          cursorFrame += d;
          on = !on;
        }
      }
    }
  }

  const tracks = [
    { id: "V1", kind: "video", clips: v1Clips },
    { id: "V2_DIALOG", kind: "video", clips: dialogClips },
    { id: "A1_VOICE", kind: "audio", clips: voiceClips },
    { id: "A2_SFX", kind: "audio", clips: sfxClips },
    { id: "A3_BGM", kind: "audio", clips: bgmClips },
  ];

  const timeline = {
    schemaVersion: 2,
    fps,
    title,
    derivedFrom: { script: outRel(scriptPath), draft: outRel(editPath) },
    totalFrames: cursor,
    totalDurationMs: Math.round(cursor * frameMs),
    chapters: chapters.map((c: any) => {
      const scene = scenes.find((s: any) => s.chapterIndex === c.index && s.type !== "toc") || {};
      return {
        index: c.index,
        title: c.title,
        menu: c.menu,
        startFrame: scene.timelineStartFrame ?? null,
        startMs: scene.timelineStartMs ?? null,
      };
    }),
    scenes,
    subtitles,
    tracks,
  };
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, JSON.stringify(timeline, null, 2) + "\n");
  ctx.log(`uvid finish timeline: wrote ${rel(ctx, output)}`);
  ctx.log(`  ${scenes.length} scenes, ${timeline.totalFrames} frames, ${(timeline.totalDurationMs / 1000).toFixed(2)}s`);
}

// ---------- OTIO export ----------

function otio(schema: string, fields: any): any { return { OTIO_SCHEMA: schema, ...fields }; }
function rt(value: number, rate: number): any { return otio("RationalTime.1", { value, rate }); }
function tr(startFrames: number, durationFrames: number, rate: number): any {
  return otio("TimeRange.1", { start_time: rt(startFrames, rate), duration: rt(durationFrames, rate) });
}
function extRef(targetUrl: string): any { return otio("ExternalReference.1", { target_url: targetUrl, available_range: null }); }
function otioClip(name: string, sourceStart: number, duration: number, rate: number, source: string, metadata: any = {}): any {
  return otio("Clip.1", {
    name,
    source_range: tr(sourceStart, duration, rate),
    effects: [],
    markers: [],
    media_reference: extRef(source),
    metadata,
    enabled: true,
  });
}
function otioGap(duration: number, rate: number): any {
  return otio("Gap.1", { name: "gap", source_range: tr(0, duration, rate), effects: [], markers: [], metadata: {}, enabled: true });
}
function otioTrack(kind: string, name: string, children: any[]): any {
  return otio("Track.1", { name, kind, children, effects: [], markers: [], source_range: null });
}
function otioStack(children: any[]): any { return otio("Stack.1", { name: "tracks", children, effects: [], markers: [], source_range: null }); }
function otioTimeline(name: string, fps: number, tracks: any[]): any {
  return otio("Timeline.1", { name, global_start_time: rt(0, fps), metadata: { "undefined-video": { schemaVersion: 1 } }, tracks: otioStack(tracks) });
}

export interface TimelineOtioParams {
  input: string;
  output: string;
}

/** Export timeline tracks as an OTIO file (Kdenlive/OpenTimelineIO consumers). */
export async function timelineCreateOtio(p: TimelineOtioParams, ctx: Ctx): Promise<void> {
  const timelinePath = resolveExisting(ctx, p.input, "input");
  const output = resolvePath(ctx, p.output);
  const tl = readJson(timelinePath);
  const fps = tl.fps;
  if (!Array.isArray(tl.tracks)) fail("timeline has no tracks[]; run finish timeline first");
  const baseDir = path.dirname(timelinePath);
  const sourceUrl = (source: string) => path.resolve(baseDir, source);

  function pushGap(children: any[], frames: number): void { if (frames > 0) children.push(otioGap(frames, fps)); }
  function emitTrack(track: any): any {
    const children: any[] = [];
    let cursor = 0;
    const kind = track.kind === "audio" ? "Audio" : "Video";
    for (const clip of [...track.clips].sort((a: any, b: any) => a.timelineStartFrame - b.timelineStartFrame)) {
      pushGap(children, clip.timelineStartFrame - cursor);
      const source = sourceUrl(clip.source);
      if (clip.compound && Array.isArray(clip.sourceRanges)) {
        let local = 0;
        for (const r of clip.sourceRanges) {
          children.push(otioClip(`${clip.id}.${r.id}`, r.sourceStartFrame, r.durationFrames, fps, source, {
            "undefined-video": { sceneId: clip.sceneId, compoundClip: clip.id, range: r },
          }));
          local += r.durationFrames;
          if (r.holdAfterFrames > 0) {
            children.push(otioClip(`${clip.id}.${r.id}.hold`, Math.max(0, r.sourceEndFrame - 1), r.holdAfterFrames, fps, source, {
              "undefined-video": { sceneId: clip.sceneId, compoundClip: clip.id, holdAfterRange: r.id, freezeHold: true },
            }));
            local += r.holdAfterFrames;
          }
        }
        if (local !== clip.durationFrames) {
          children.push(otioGap(Math.max(0, clip.durationFrames - local), fps));
        }
      } else {
        children.push(otioClip(clip.id, clip.sourceStartFrame || 0, clip.durationFrames, fps, source, {
          "undefined-video": { sceneId: clip.sceneId, mode: clip.mode || null },
        }));
      }
      cursor = clip.timelineStartFrame + clip.durationFrames;
    }
    return otioTrack(kind, track.id, children);
  }

  const out = otioTimeline(path.basename(output, path.extname(output)), fps, tl.tracks.map(emitTrack));
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, JSON.stringify(out, null, 2) + "\n");
  ctx.log(`uvid deliver otio: wrote ${rel(ctx, output)}`);
  ctx.log(`  tracks: ${tl.tracks.map((t: any) => `${t.id}:${t.clips.length}`).join(", ")}`);
}
