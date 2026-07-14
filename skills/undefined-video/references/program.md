# Program deliverable — packaging → final mp4

**Done means:** `program.mp4` (+ `program.ass` / `program.srt` / optional `program.otio`) at episode root, reviewed in mpv. Body cut is already accepted via `timeline.aroll.json` (see `edit.md`).

`edit.json` should be at least `video-reviewed` (body accepted) before packaging.
Flip to `ready` only after this document’s mpv review (and cover if in scope).

Packaging is applied only on `generate timeline` (not `generate video`). Without packaging flags the timeline is `basis=aroll`; with intro/toc/outro it becomes `basis=program`.

## Resume / skip (decide before any export or render)

Inspect first. If all of these already exist and match contracts:

- `clips/bgm.mp3` (not root `bgm.mp3`) from current `bgm.mml`, duration covers intro-end→outro-start
- `timeline.program.json` with `basis: "program"`, packaging paths, `bgm.media: "clips/bgm.mp3"`
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
  → bgm.mml → clips/bgm.mp3          # see bgm.md; window = aroll + TOC
  → timeline.program.json            # packaging + dialog + bgm + captionsStyle
  → program.srt / program.ass
  → program.mp4
  → (optional) program.otio
  → mpv review → status: ready
```

## 1. BGM bed

Estimate and export first (details in `bgm.md`):

```text
bgmSec ≈ aroll.durationMs/1000 + sum(toc durations)
```

```bash
uvid generate bgm -i bgm.mml -o clips/bgm.mp3 --duration <bgmSec>
```
```jsonc
// pi: uvid_generate_bgm
{ "input": "bgm.mml", "output": "clips/bgm.mp3", "duration": 62 }
```

## 2. Program timeline

`--toc-before` source ids must match chapter starts in script order. One TOC clip per `##` chapter that has body media after it. Paths are episode-relative; duration/audio are probed from the files.

```bash
uvid generate timeline -i edit.json -o timeline.program.json \
  --intro clips/intro.mp4 \
  --outro clips/outro.mp4 \
  --toc-before 02,03,04 \
  --toc clips/toc1.mp4,clips/toc2.mp4,clips/toc3.mp4 \
  --dialog clips/dialog \
  --bgm clips/bgm.mp3 \
  --fg '#abb2bf' --bg '#282c34'
```
```jsonc
// pi: uvid_generate_timeline
{
  "input": "edit.json",
  "output": "timeline.program.json",
  "intro": "clips/intro.mp4",
  "outro": "clips/outro.mp4",
  "tocBefore": "02,03,04",
  "toc": "clips/toc1.mp4,clips/toc2.mp4,clips/toc3.mp4",
  "dialog": "clips/dialog",
  "bgm": "clips/bgm.mp3",
  "fg": "#abb2bf",
  "bg": "#282c34"
}
```

`--fg` / `--bg` / `--font` / `--font-size` land on `timeline.captionsStyle` and are burned by `generate video`. Match `script.md` theme (e.g. onedark `#abb2bf` / `#282c34`).

### Accept

- `basis: "program"`, `timeline.program.json` at **episode root**.
- Packaging segments present: intro, each toc, outro; aroll body unchanged in content.
- `timeline.bgm.startMs/endMs` = intro end → outro start; `dialogSprites.dir` set when `--dialog` passed.
- Captions still show CJK–Latin spaces in both `text` and `words[]` (ASS paints `words[]`).

## 3. Captions + render

```bash
uvid generate captions -i timeline.program.json -o program.srt -f srt
uvid generate captions -i timeline.program.json -o program.ass --fg '#abb2bf' --bg '#282c34'
uvid generate video -i timeline.program.json -o program.mp4 --quality standard
# optional NLE export
uvid generate otio -i timeline.program.json -o program.otio
mpv program.mp4
```
```jsonc
// pi tools
{ "input": "timeline.program.json", "output": "program.srt", "format": "srt" }
{ "input": "timeline.program.json", "output": "program.ass", "fg": "#abb2bf", "bg": "#282c34" }
{ "input": "timeline.program.json", "output": "program.mp4", "quality": "standard" }
{ "input": "timeline.program.json", "output": "program.otio" }
```

`generate video` reads **only** the timeline (segments, dialog, bgm, captionsStyle). No side asset flags. Preview path stays `cache/preview.*`; deliverables stay at root.

### Checklist

- [ ] Inspected existing `clips/bgm.mp3` / `timeline.program.json` / `program.mp4`; skipped rebuild when already valid.
- [ ] Body already accepted on aroll; packaging assets exist under `clips/`.
- [ ] BGM path is `clips/bgm.mp3` (never episode-root `bgm.mp3`); duration ≥ intro-end→outro-start window.
- [ ] TOC order matches script chapters / `toc-before` source ids.
- [ ] ASS typewriter shows spaces at CJK–Latin boundaries (not only SRT).
- [ ] Dialog sprite + BGM present under speech; hidden/silent on packaging if designed so.
- [ ] Human reviewed `program.mp4` in mpv (and cover if requested); then `edit.json` `status: ready`.
- [ ] Cover: `cover.png` per `references/cover.md` (theme palette + title + 1146×717).
