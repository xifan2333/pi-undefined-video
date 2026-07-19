# Prep — pre-production

**Done means:** packaging visuals under `clips/`, normalized `clips/NN.media.*`,
and word-level `cache/NN.asr.json` for every source. No sparse edit actions,
no program packaging.

All tool `input`/`output` paths are **absolute under the episode root**
(`<EPISODE>/…`). Examples below already use that form — substitute the real
episode absolute path. Skill docs live under `SKILL_DIR`; never `read`
`references/` from the episode.

## Resume / skip (decide before any generate)

Inspect the episode first. For each prep product that already exists and
passes its accept checklist, **skip regenerate**. If **all** prep products
for the requested sources are present and valid:

1. Run non-mutating verification only (ffprobe / file shape checks).
2. Report prep complete.
3. **Stop** — do not author `edit.json` actions, timeline, or program work.

Only rebuild a product when its upstream input changed or accept failed.
Do not center a prep reply on a full greenfield tool list when the fixture
is already prep-complete.

## Step 1 — Prepare fixed assets (packaging visuals)

**Done means:** every packaging visual exists under `clips/` as a valid media file.
These are "fixed" — they depend on `script.md` only, not on any cut decision, so
they can be built as soon as the script is final. Durations are owned by the
templates / held later by `uvid_generate_timeline`; this step only produces the assets.

Scene projects go to `cache/scenes/` (disposable); rendered products go to `clips/`.
Each asset is two tools: `uvid_generate_scene` → a HyperFrames project dir, then
`uvid_generate_render` → the media. `theme` comes from the script frontmatter.

### Do

**intro / outro** — one per episode, fixed brand cards:

```jsonc
// uvid_generate_scene
{ "type": "intro", "theme": "onedark", "output": "<EPISODE>/cache/scenes/intro" }
// uvid_generate_render
{ "input": "<EPISODE>/cache/scenes/intro", "output": "<EPISODE>/clips/intro.mp4" }

// uvid_generate_scene
{ "type": "outro", "theme": "onedark", "output": "<EPISODE>/cache/scenes/outro" }
// uvid_generate_render
{ "input": "<EPISODE>/cache/scenes/outro", "output": "<EPISODE>/clips/outro.mp4" }
```

**toc** — one clip per `##` chapter. Pass the full chapter list every time;
`current` (0-based) selects which row is highlighted:

```jsonc
// uvid_generate_scene  (repeat current 1 → toc2, current 2 → toc3)
{
  "type": "toc",
  "theme": "onedark",
  "chapters": "终端与 ls,ls 结合 grep,Cheat Sheet 补充",
  "current": 0,
  "output": "<EPISODE>/cache/scenes/toc1"
}
// uvid_generate_render
{ "input": "<EPISODE>/cache/scenes/toc1", "output": "<EPISODE>/clips/toc1.mp4" }
```

**markdown pictures** — one per `<audio>` source; this is that source's
`source.visual`. The body is the markdown **after** the `<audio>` tag up to the
next `---`, excluding the block's leading `#`/`##` heading (headings are title /
chapter, not picture). Render a **png still** (held to the audio's length later):

```jsonc
// write the sliced body to cache/md-body/NN.md, then:
// uvid_generate_scene
{
  "type": "markdown",
  "theme": "onedark",
  "input": "<EPISODE>/cache/md-body/01.md",
  "output": "<EPISODE>/cache/scenes/md-01"
}
// uvid_generate_render
{ "input": "<EPISODE>/cache/scenes/md-01", "output": "<EPISODE>/clips/01.visual.png", "format": "png" }
```

**dialog** — one sprite set per episode (4 named RGBA stills for the talking-head chrome):

```jsonc
// uvid_generate_scene
{ "type": "dialog", "theme": "onedark", "output": "<EPISODE>/cache/scenes/dialog" }
// uvid_generate_render
{ "input": "<EPISODE>/cache/scenes/dialog", "output": "<EPISODE>/clips/dialog", "format": "sprite" }
```

**freeform HyperFrames (motion or static frame) is not a prep step.** Do **not**
author or render custom inserts here. Prep only builds **stock** packaging
(intro/outro/toc/markdown stills/dialog) via `uvid_generate_scene`. Freeform later
uses agent-written HTML + `uvid_generate_render` only — **never**
`uvid_generate_scene`.

After `video-reviewed`: `<SKILL_DIR>/references/freeform.md`.

### Accept

No `analyze` for images — use `ffprobe`:

- intro / outro / toc `.mp4`: has a video stream and `duration > 0`.
- markdown `.visual.png`: a valid image (expected 1280×720).
- dialog: all four exist — `idle.png`, `talk-closed.png`, `talk-open.png`, `wait-on.png` (RGBA).

### Checklist

- [ ] `clips/intro.mp4` and `clips/outro.mp4` exist (video + duration).
- [ ] One `clips/tocN.mp4` per `##`, highlighting the right chapter.
- [ ] One `clips/NN.visual.png` per `<audio>` source (heading excluded from body).
- [ ] `clips/dialog/` holds the four RGBA sprite stills.

## Step 2 — Loudness-normalize every script media

**Done means:** every media referenced by `script.md` has a normalized product at
`clips/NN.media.<ext>`, and each product passes the loudness acceptance check.

### Do

1. Parse `script.md`; collect every `<audio|video src="raw/NN.ext">`. `NN` is the
   source id; the tag name (`audio`/`video`) selects the branch.
2. The tag is an **editing declaration, not a probe** — a raw file may carry video
   even when tagged `<audio>`. Follow the tag, not the container:
   - `<audio>` → `format` omit / mp3: keep normalized audio only, drop the picture
     (its picture comes later from markdown / a still).
   - `<video>` → `format: "mp4"`: keep the picture (video stream-copied), audio normalized.
3. Target **−16 LUFS / −1.5 dBTP / 11 LRA** for every source (one target per episode).
4. Write to `clips/NN.media.<ext>` — this is each source's `source.media`.

One invocation per file; loop outside.

```jsonc
// uvid_generate_normalize
{ "input": "<EPISODE>/raw/01.mp4", "output": "<EPISODE>/clips/01.media.mp3", "lufs": -16, "tp": -1.5, "lra": 11 }  // <audio>
{ "input": "<EPISODE>/raw/02.mp4", "output": "<EPISODE>/clips/02.media.mp4", "format": "mp4", "lufs": -16, "tp": -1.5, "lra": 11 }  // <video>
```

### Accept — verify loudness

For each product, read the measurement from the tool result (no file needed):

```jsonc
// uvid_analyze_loudness  (no output → JSON in the tool result)
{ "input": "<EPISODE>/clips/NN.media.<ext>" }
```

Pass when **`|I − (−16)| ≤ 1.0`** and **`peak ≤ −1.5`**.

- `1 LU ≈ 1 dB`; a difference below ~1 LU is imperceptible, so ±1.0 keeps every
  source at the same apparent loudness (EBU R128 convention). ~3 dB is where a
  listener clearly hears "louder / quieter".
- `peak` here is sample peak (dBFS), which is ≤ the true-peak (dBTP) target — a
  conservative clipping check, sufficient in practice.

### Checklist

- [ ] Every `script.md` media has a `clips/NN.media.<ext>`.
- [ ] `<audio>` → mp3 (audio only); `<video>` → mp4 (picture kept).
- [ ] Each product: `|I + 16| ≤ 1.0` and `peak ≤ −1.5`.

## Step 3 — Transcribe each normalized segment (ASR)

**Done means:** every source has `cache/NN.asr.json`, ready to feed `uvid_generate_edit`.

Transcribe the **normalized** media from Step 2 (`clips/NN.media.*`), not `raw/` —
clean audio transcribes more accurately and its timeline matches the media compile
will use. Audio sources (mp3) upload directly; video sources (mp4) have their audio
extracted automatically.

### Do

**Prefer the built-in tool `transcribe_media`.**
Write the same shape: `SubtitleSegment[]` with word-level timings to `cache/NN.asr.json`.

Request `json` format — it carries word-level timestamps. The output is a
`SubtitleSegment[]` (`[{ text, startMs, endMs, words:[{text,startMs,endMs}] }]`),
which is exactly the ASR shape `uvid_generate_edit` accepts (zero conversion).

One invocation per file; loop outside. Write to `cache/NN.asr.json`.

```jsonc
// transcribe_media
{ "input": "<EPISODE>/clips/01.media.mp3", "output": "<EPISODE>/cache/01.asr.json", "formats": ["json"] }
{ "input": "<EPISODE>/clips/02.media.mp4", "output": "<EPISODE>/cache/02.asr.json", "formats": ["json"] }
```

### Accept

- Each `cache/NN.asr.json` is a non-empty array of `{ text, startMs, endMs, words }`.
- `uvid_generate_edit` with those paths ingests them without a shape error.

### Checklist

- [ ] Every source has a `cache/NN.asr.json` (json format, word-level).
- [ ] Transcribed the normalized `clips/NN.media.*`, not `raw/`.
- [ ] Each file is a `SubtitleSegment[]` that `uvid_generate_edit` accepts.
