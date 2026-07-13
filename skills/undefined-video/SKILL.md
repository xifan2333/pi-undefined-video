---
name: undefined-video
description: >
  Episode workflow for pi-undefined-video. Use for prep (script.md → normalize →
  ASR → audio static visuals), sparse edit intent (edit.json), and post-edit
  compile (timeline.json → video / captions / otio). Trigger on uvid,
  undefined-video, episode video, script.md, edit.json, timeline.json, raw
  media, prep, normalize, transcription, ASR, cache, hold_until, generate
  timeline/video/captions, or reviewing episode cuts.
---

# undefined-video

Use this skill for episode **prep**, **edit intent**, and **post-edit compile**.

Stable scopes:

```text
prep:     script.md → normalize → ASR → audio-block static visuals
edit:     cache ASR → edit.json sparse actions → atomic evidence
compile:  edit.json → timeline.json → video / captions / otio
```

Do not invent parallel formats. In particular:

- Do not create any `draft.json` or other parallel edit artifact; `edit.json` is the only intent file.
- `edit.json` follows `schemas/edit.schema.json` (v0.1). Read `references/edit.md`.
- `timeline.json` (`uvid.timeline`) is the only intermediate geometry product. Schema: `schemas/timeline.schema.json`.
- Soft cuts (edge snap / afade) are compile defaults, not new edit ops.
- Packaging is applied by `generate timeline`, not by `generate video`: `--intro` / `--outro` are explicit media paths (duration probed); TOC via `--toc-before ID,ID,…`.
- RPG typewriter captions: `generate captions -o out.ass` — karaoke `\k`, 1 event/turn, transparent Secondary (unrevealed glyphs do not paint). Style knobs: `--fg` / `--bg` / `--font` / `--font-size`. Preview SRT stays turn-level.
- Do not add ASR to this package; ASR comes from `transcribe_media`.

## Files that matter now

| Path | Role |
|---|---|
| `script.md` | Episode script and source declarations |
| `edit.json` | Sparse editing intent (v0.1) |
| `timeline.json` | Compiled program geometry (`uvid.timeline`) |
| `raw/` | Original recorded media |
| `cache/<id>/` | Prep outputs for each source |
| `schemas/edit.schema.json` | Machine schema for `edit.json` |
| `schemas/timeline.schema.json` | Machine schema for `timeline.json` |
| `clips/` | Later timeline/deliver material pool |

## When prepping an episode

Read `references/prep.md` and follow it exactly.

Also read `references/script.md` when checking or extracting `script.md` structure.

## When authoring or reviewing edit.json

Read `references/edit.md` and follow it exactly.

Skeleton after prep — equal-length multi-args (or single source):

```bash
uvid generate edit \
  -i cache/01/asr.json,cache/02/asr.json -o edit.json \
  --id 01,02 --type audio,video \
  --media cache/01/normalized.mp3,cache/02/normalized.mp4 \
  --visual cache/01/visual.png,-
```

Validate shape against package schema `schemas/edit.schema.json`.

Review order:

```text
subtitle-draft → audio-reviewed → video-reviewed → ready
```

Use atomic tools only (`analyze silence/waveform/frame-diff`, frame stills). Any unresolved `check` blocks `ready`.

## After edit is ready — compile

```bash
# geometry — bind ALL product assets onto timeline (packaging / dialog / bgm / ASS look)
uvid generate timeline -i edit.json -o timeline.aroll.json
uvid generate timeline -i edit.json -o timeline.program.json \
  --intro clips/intro.mp4 --outro clips/outro.mp4 \
  --toc-before 02,03,04 --toc clips/toc1.mp4,clips/toc2.mp4,clips/toc3.mp4 \
  --dialog clips/dialog --bgm clips/bgm.mp3 \
  --fg '#abb2bf' --bg '#282c34'

# episode mp4 from timeline only (no side asset flags)
uvid generate video -i timeline.program.json -o program-final.mp4 --quality draft

# optional side exports (also from timeline)
uvid generate captions -i timeline.program.json -o out.ass
uvid generate captions -i timeline.program.json -o out.srt
uvid generate otio -i timeline.program.json -o out.otio
```

Boundary: `generate render` = scene dir → one media. Episode assemble = `generate video` reading **only** `timeline.json` (assets already bound: packaging, `dialog[]`, `dialogSprites`, `bgm`, `captionsStyle`).

## Creative files

Three AI/human-authored files:

| File | Status |
|---|---|
| `script.md` | Stable; see `references/script.md` |
| `edit.json` | v0.1 contract; see `references/edit.md` + `schemas/edit.schema.json` |
| `bgm.mml` | Stable enough for BGM generation; see `references/bgm.md` |
