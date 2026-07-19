# Freeform HyperFrames inserts (after aroll only)

**Done means:** either a **motion** packaging mp4 or a **static** body png exists
under `clips/`, accepted, and wired into timeline the right way. Authoring is
agent-written HyperFrames under `cache/scenes/` — **never** `uvid_generate_scene`.

**Gate:** `edit.json` status ≥ `video-reviewed`, `timeline.aroll.json` accepted.
Do **not** author freeform during prep or during subtitle / audio / visual passes.

Load this file only when the user wants custom inserts. Ordinary packaging
(`program.md`) does not require it.

## Decision tree

```text
video-reviewed?
  no  → finish aroll first (edit.md); stop freeform
  yes → motion sting / custom intro-outro-toc?
          yes → write HTML → uvid_generate_render → clips/<id>.mp4
                → pass as intro | outro | toc (probed duration = segment length)
          no  → custom body still (stock markdown not enough)?
                  yes → write HTML → uvid_generate_render format=png
                        → sources[].visual only (speech/hold owns length)
                  no  → use stock prep assets; skip freeform
```

Never: `uvid_generate_scene` for freeform · freeform during prep/edit cut ·
static png as `intro` / `outro` / `toc`.

Prefer stock `type=markdown` visuals when that layout is enough.

## Why after aroll

| If you freeform **before** aroll is frozen… | What breaks |
|---|---|
| Later `drop` / `hold_until` / silence cuts | Aroll duration changes → BGM window and packaging rhythm wrong |
| Chapter / source order still moving | TOC list / insert placement goes stale |
| Visual pass still open | Motion or still may fight `hold_until` or get deleted by the cut |
| Stock markdown `visual` still provisional | Freeform still can be overwritten |

Stock template intro/outro/toc from prep are OK early (cut-independent). Freeform
is cut-dependent — same stage family as program packaging.

## Two products

| Product | Output | Wire role | On-screen duration |
|---|---|---|---|
| **Motion insert** | `clips/<id>.mp4` | Packaging only: `intro` / `outro` / one `toc` path | Root `data-duration` → render → **ffprobe** on mp4 |
| **Static frame** | `clips/<id>.png` or `clips/NN.visual.png` | Body only: `sources[].visual` — **never** intro/outro/toc | **Speech / aroll / hold_until** holds the still |

Both: `cache/scenes/<id>/` by agent `write` → `uvid_generate_render` only.

## Steps (gate passed)

1. Confirm aroll accept (preview reviewed; no open `check`; `video-reviewed`).
2. Pick motion vs static (table above).
3. Author HyperFrames under `<EPISODE>/cache/scenes/<id>/`.
4. Render motion → `.mp4` or static → `.png` (`format: "png"`, optional `atMs`).
5. Accept file, then wire:
   - motion: include probed duration in BGM estimate when it sits on packaging
     paths that affect the bed window (TOC yes; intro/outro sit outside the BGM
     bed — see `bgm.md` / `program.md`); pass path into `uvid_generate_timeline`
   - static: set `sources[].visual`; re-run aroll and/or program timeline (length
     still follows speech/hold)

## A. Motion insert

Episode canvas: **1280×720**. Three clocks (do not mix):

| Clock | Owner | Role |
|---|---|---|
| Root `data-duration` (s) | HTML | HyperFrames **render** length |
| GSAP timeline | HTML | Seek graph only when root duration is set |
| Program timeline | `ffprobe` on rendered file | Packaging segment length |

Minimal shape (full HyperFrames rules: hyperframes-core — root
`data-composition-id` + size + static `data-duration`; direct-child
`class="clip"` nodes; one paused `window.__timelines[id]`):

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <link rel="stylesheet" href="assets/themes.css" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1280px; height: 720px; overflow: hidden; }
    #root { position: relative; width: 1280px; height: 720px; overflow: hidden; }
    .fill { position: absolute; inset: 0; background: var(--bg, #282c34); }
  </style>
</head>
<body>
  <div id="root"
       data-theme="onedark"
       data-composition-id="insert-a"
       data-width="1280" data-height="720"
       data-duration="4" data-fps="25">
    <div class="fill" aria-hidden="true"></div>
    <section id="card" class="clip"
             data-start="0" data-duration="4" data-track-index="1">
      <!-- content locked to accepted cut -->
    </section>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.from("#card", { opacity: 0, duration: 0.4 }, 0);
    window.__timelines["insert-a"] = tl;
  </script>
</body>
</html>
```

Optional theme: copy package `templates/_shared/themes.css` → scene
`assets/themes.css` (not skill `assets/` path for the scene link). `data-theme`
is uvid palette convenience, not a HyperFrames core attribute.

```jsonc
// uvid_generate_render — motion
{
  "input": "<EPISODE>/cache/scenes/insert-a",
  "output": "<EPISODE>/clips/insert-a.mp4",
  "quality": "high"
}
```

```jsonc
// timeline packaging example — custom intro
{
  "input": "<EPISODE>/edit.json",
  "output": "<EPISODE>/timeline.program.json",
  "intro": "<EPISODE>/clips/insert-a.mp4",
  "outro": "<EPISODE>/clips/outro.mp4",
  "tocBefore": "02",
  "toc": "<EPISODE>/clips/toc1.mp4",
  "dialog": "<EPISODE>/clips/dialog",
  "bgm": "<EPISODE>/clips/bgm.mp3"
}
```

## B. Static frame

Use when the body needs a **designed still** for speech (or hold), not a motion
sting. Prefer stock markdown stills first.

| Layer | Role |
|---|---|
| HTML `data-duration` | Valid compile length only (often `1` if nothing animates) — **not** program hold length |
| `format: "png"` + `atMs` | Snapshot (default `0`); prefer settled layout at t=0 |
| Aroll / program | Picture length = kept audio (+ `hold_until`) |

```html
<div id="root"
     data-theme="onedark"
     data-composition-id="card-01"
     data-width="1280" data-height="720"
     data-duration="1" data-fps="25">
  <div class="fill" aria-hidden="true"></div>
  <section id="card" class="clip"
           data-start="0" data-duration="1" data-track-index="1">
    <!-- final layout at t=0 -->
  </section>
</div>
<script>
  window.__timelines = window.__timelines || {};
  window.__timelines["card-01"] = gsap.timeline({ paused: true });
</script>
```

```jsonc
// uvid_generate_render — static
{
  "input": "<EPISODE>/cache/scenes/card-01",
  "output": "<EPISODE>/clips/01.visual.png",
  "format": "png",
  "atMs": 0
}
```

Wire:

1. Set that audio source’s `visual` to the png (absolute under episode in tools).
2. Re-run `uvid_generate_timeline` for aroll and/or program.
3. Never pass a png as `intro` / `outro` / `toc` — timed packaging uses **mp4**.

Accept: valid **1280×720** png; readable at episode scale; theme hex if used.

## Reopen rule

If aroll reopens after freeform exists: re-accept without packaging change, or
**re-author / re-render** freeform and recompile timeline. Do not hand-patch
timeline JSON for length.

## Checklist

- [ ] Status ≥ `video-reviewed` before any freeform author/render.
- [ ] No `uvid_generate_scene` for freeform.
- [ ] Motion: mp4 packaging path; duration ≈ HTML `data-duration` (ffprobe).
- [ ] Static: png → `sources[].visual` only; length follows speech/hold.
- [ ] Timeline recompiled after wire; BGM re-estimated if packaging durations changed.
