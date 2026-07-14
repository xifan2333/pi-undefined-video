# Prep — pre-production

## Step 1 — Prepare fixed assets (packaging visuals)

**Done means:** every packaging visual exists under `clips/` as a valid media file.
These are "fixed" — they depend on `script.md` only, not on any cut decision, so
they can be built as soon as the script is final. Durations are owned by the
templates / held later by `generate timeline`; this step only produces the assets.

Scene projects go to `cache/scenes/` (disposable); rendered products go to `clips/`.
Each asset is two commands: `generate scene` → a HyperFrames project dir, then
`generate render` → the media. `--theme` comes from the script frontmatter.

### Do

**intro / outro** — one per episode, fixed brand cards:

```bash
uvid generate scene  --type intro --theme onedark -o cache/scenes/intro
uvid generate render -i cache/scenes/intro -o clips/intro.mp4
uvid generate scene  --type outro --theme onedark -o cache/scenes/outro   # default avatar
uvid generate render -i cache/scenes/outro -o clips/outro.mp4
```

**toc** — one clip per `##` chapter. Pass the full chapter list every time;
`--current` (0-based) selects which row is highlighted:

```bash
CH='终端与 ls,ls 结合 grep,Cheat Sheet 补充'
uvid generate scene  --type toc --theme onedark --chapters "$CH" --current 0 -o cache/scenes/toc1
uvid generate render -i cache/scenes/toc1 -o clips/toc1.mp4
# repeat --current 1 → toc2, --current 2 → toc3
```

**markdown pictures** — one per `<audio>` source; this is that source's
`source.visual`. The body is the markdown **after** the `<audio>` tag up to the
next `---`, excluding the block's leading `#`/`##` heading (headings are title /
chapter, not picture). Render a **png still** (held to the audio's length later):

```bash
# write the sliced body to cache/md-body/NN.md, then:
uvid generate scene  --type markdown --theme onedark -i cache/md-body/01.md -o cache/scenes/md-01
uvid generate render -i cache/scenes/md-01 -o clips/01.visual.png -f png
```

**dialog** — one sprite set per episode (4 named RGBA stills for the talking-head chrome):

```bash
uvid generate scene  --type dialog --theme onedark -o cache/scenes/dialog
uvid generate render -i cache/scenes/dialog -o clips/dialog -f sprite
```

pi-tool forms (params are camelCase; `-f` → `format`, sprite/png set via `format`):

```jsonc
// uvid_generate_scene
{ "type": "intro",    "theme": "onedark", "output": "cache/scenes/intro" }
{ "type": "outro",    "theme": "onedark", "output": "cache/scenes/outro" }
{ "type": "toc",      "theme": "onedark", "chapters": "a,b,c", "current": 0, "output": "cache/scenes/toc1" }
{ "type": "markdown", "theme": "onedark", "input": "cache/md-body/01.md", "output": "cache/scenes/md-01" }
{ "type": "dialog",   "theme": "onedark", "output": "cache/scenes/dialog" }
// uvid_generate_render
{ "input": "cache/scenes/intro", "output": "clips/intro.mp4" }
{ "input": "cache/scenes/md-01", "output": "clips/01.visual.png", "format": "png" }
{ "input": "cache/scenes/dialog", "output": "clips/dialog", "format": "sprite" }
```

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
   - `<audio>` → `-f mp3`: keep normalized audio only, drop the picture (its picture
     comes later from markdown / a still).
   - `<video>` → `-f mp4`: keep the picture (video stream-copied), audio normalized.
3. Target **−16 LUFS / −1.5 dBTP / 11 LRA** for every source (one target per episode).
4. Write to `clips/NN.media.<ext>` — this is each source's `source.media`.

One invocation per file; loop outside.

```bash
# CLI
uvid generate normalize -i raw/01.mp4 -o clips/01.media.mp3        --lufs -16 --tp -1.5 --lra 11  # <audio>
uvid generate normalize -i raw/02.mp4 -o clips/02.media.mp4 -f mp4 --lufs -16 --tp -1.5 --lra 11  # <video>
```
```jsonc
// pi tool: uvid_generate_normalize
{ "input": "raw/01.mp4", "output": "clips/01.media.mp3",                     "lufs": -16, "tp": -1.5, "lra": 11 }  // <audio>
{ "input": "raw/02.mp4", "output": "clips/02.media.mp4", "format": "mp4", "lufs": -16, "tp": -1.5, "lra": 11 }  // <video>
```

### Accept — verify loudness

For each product, read the measurement from stdout (no file needed):

```bash
# CLI（reads stdout）
uvid analyze loudness -i clips/NN.media.<ext>
```
```jsonc
// pi tool: uvid_analyze_loudness（no output → JSON in the tool result）
{ "input": "clips/NN.media.<ext>" }
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
