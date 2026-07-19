# Program deliverable — packaging → final mp4

**Done means:** `program.mp4` (+ `program.ass` / `program.srt` / optional `program.otio`) at episode root, reviewed in mpv. Body cut is already accepted via `timeline.aroll.json` (see `<SKILL_DIR>/references/edit.md`).

`edit.json` should be at least `video-reviewed` (body accepted) before packaging.
Flip to `ready` only after this document’s mpv review (and cover if in scope).

Packaging is applied only on `uvid_generate_timeline` (not `uvid_generate_video`). Without packaging params the timeline is `basis=aroll`; with intro/toc/outro it becomes `basis=program`.

Tool `input`/`output` and packaging path params use **absolute** `<EPISODE>/…` (examples below).

## Contents

- [Resume / skip](#resume--skip-decide-before-any-export-or-render)
- [Order](#order)
- [Optional freeform inserts](#optional-freeform-inserts)
- [1. BGM bed](#1-bgm-bed)
- [2. Program timeline](#2-program-timeline)
- [3. Captions + render](#3-captions--render)
- [Checklist](#checklist)

## Resume / skip (decide before any export or render)

Inspect first. If all of these already exist and match contracts:

- `clips/bgm.mp3` (not root `bgm.mp3`) from current `bgm.mml`, duration covers intro-end→outro-start
- `timeline.program.json` with `basis: "program"`, packaging paths, `bgm.media` pointing at `clips/bgm.mp3`
- `program.mp4` (+ captions) whose duration aligns with the program timeline
- `edit.json` status already `ready` **or** user only asked to package and did not reject the current program

then the **primary decision is no-op / skip re-packaging**: report the existing
deliverables and stop. Do **not** re-export BGM, recompile `timeline.program.json`,
or re-render `program.mp4` just because the user said “打包”.

Rebuild only when packaging inputs changed, a contract check failed, or the user
explicitly asks to redo program.

Aroll acceptance remains `video-reviewed`. Setting `ready` still requires program
(and cover if requested) human review — but do not demote an already-`ready`
episode when re-stating a packaging plan for a finished tree.

## Order

```text
edit.json (status ≥ video-reviewed; body accepted)
  → (optional) freeform inserts   # only if needed; see freeform.md
  → bgm.mml → clips/bgm.mp3       # bed ≈ aroll + TOC (intro/outro outside bed)
  → timeline.program.json         # packaging + dialog + bgm + captionsStyle
  → program.srt / program.ass
  → program.mp4
  → (optional) program.otio
  → mpv review → status: ready
```

## Optional freeform inserts

Skip this section for stock packaging. When the user wants **custom** motion
intro/outro/toc or a **custom static** body card after aroll:

→ full contract: `<SKILL_DIR>/references/freeform.md`

Quick rules (detail in freeform.md):

| | Motion | Static frame |
|---|---|---|
| Gate | `video-reviewed` | same |
| Tool | agent `write` + `uvid_generate_render` — **no** `uvid_generate_scene` | same |
| Output | `clips/<id>.mp4` | `clips/<id>.png` / `NN.visual.png` |
| Wire | `intro` / `outro` / `toc` | `sources[].visual` only |
| Duration | probed mp4 | speech / hold |

## 1. BGM bed

Estimate and export first (details in `<SKILL_DIR>/references/bgm.md`):

```text
bgmSec ≈ aroll.durationMs/1000 + sum(toc durations)
```

```jsonc
// uvid_generate_bgm
{ "input": "<EPISODE>/bgm.mml", "output": "<EPISODE>/clips/bgm.mp3", "duration": 62 }
```

## 2. Program timeline

`tocBefore` source ids must match chapter starts in script order. One TOC clip per `##` chapter that has body media after it. Pass absolute media paths; duration/audio are probed from the files.

Freeform **motion** packaging clips (see `<SKILL_DIR>/references/freeform.md`)
are the same: **timeline length = probed file duration**, not the HTML source.
Freeform **static frames** (`.png` as `source.visual`) do not set segment length
— speech/hold does. Re-render + re-run this timeline step after changing motion
duration or visual paths.

```jsonc
// uvid_generate_timeline
{
  "input": "<EPISODE>/edit.json",
  "output": "<EPISODE>/timeline.program.json",
  "intro": "<EPISODE>/clips/intro.mp4",
  "outro": "<EPISODE>/clips/outro.mp4",
  "tocBefore": "02,03,04",
  "toc": "<EPISODE>/clips/toc1.mp4,<EPISODE>/clips/toc2.mp4,<EPISODE>/clips/toc3.mp4",
  "dialog": "<EPISODE>/clips/dialog",
  "bgm": "<EPISODE>/clips/bgm.mp3",
  "fg": "#abb2bf",
  "bg": "#282c34"
}
```

`fg` / `bg` / `font` / `fontSize` land on `timeline.captionsStyle` and are burned by `uvid_generate_video`. Match `script.md` theme (e.g. onedark `#abb2bf` / `#282c34`).

### Accept

- `basis: "program"`, `timeline.program.json` at **episode root**.
- Packaging segments present: intro, each toc, outro; aroll body unchanged in content.
- `timeline.bgm.startMs/endMs` = intro end → outro start; `dialogSprites.dir` set when `dialog` passed.
- Captions still show CJK–Latin spaces in both `text` and `words[]` (ASS paints `words[]`).

## 3. Captions + render

```jsonc
// uvid_generate_captions
{ "input": "<EPISODE>/timeline.program.json", "output": "<EPISODE>/program.srt", "format": "srt" }
{ "input": "<EPISODE>/timeline.program.json", "output": "<EPISODE>/program.ass", "fg": "#abb2bf", "bg": "#282c34" }
// uvid_generate_video
{ "input": "<EPISODE>/timeline.program.json", "output": "<EPISODE>/program.mp4", "quality": "standard" }
// optional NLE export — uvid_generate_otio
{ "input": "<EPISODE>/timeline.program.json", "output": "<EPISODE>/program.otio" }
// then review externally: mpv program.mp4
```

`uvid_generate_video` reads **only** the timeline (segments, dialog, bgm, captionsStyle). No side asset flags. Preview path stays `cache/preview.*`; deliverables stay at root.

### Checklist

- [ ] Inspected existing `clips/bgm.mp3` / `timeline.program.json` / `program.mp4`; skipped rebuild when already valid.
- [ ] Body already accepted on aroll; packaging assets exist under `clips/`.
- [ ] BGM path is `clips/bgm.mp3` (never episode-root `bgm.mp3`); duration ≥ intro-end→outro-start window.
- [ ] TOC order matches script chapters / `tocBefore` source ids.
- [ ] ASS typewriter shows spaces at CJK–Latin boundaries (not only SRT).
- [ ] Dialog sprite + BGM present under speech; hidden/silent on packaging if designed so.
- [ ] Human reviewed `program.mp4` in mpv (and cover if requested); then `edit.json` `status: ready`.
- [ ] Cover: `cover.png` per `<SKILL_DIR>/references/cover.md` (theme palette + title; default 1146×717 / ≥ recommended floor, ≤5MB).
