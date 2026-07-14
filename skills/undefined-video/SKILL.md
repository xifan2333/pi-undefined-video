---
name: undefined-video
description: >
  Episode video production with pi-undefined-video (uvid): script.md → normalize/ASR
  → sparse edit.json → aroll/program timeline → program.mp4 + Bilibili cover.png.
  Use whenever the user mentions uvid, pi-undefined-video, 做一期视频/口播成片,
  edit.json, sparse cuts, timeline.aroll/program, program.mp4, bgm.mml, B 站封面,
  or the full episode pipeline (raw clips → packaged deliverable). Also use for
  partial steps inside that pipeline (only ASR, only subtitle pass, only packaging,
  only cover). Do NOT use for freeform HTML/motion compositions (HyperFrames
  workflows), product-launch promos, PR explainers, or plain subtitle burn-in on
  an already-finished video without the uvid episode layout.
license: MIT
compatibility: >
  Node >=20; uvid from this package; ffmpeg/ffprobe; mpv for review; ASR via
  pi tool transcribe_media (preferred in-session) or jianying-subtitle CLI;
  HyperFrames only as the backend of uvid generate scene/render; FamiStudio for
  generate bgm; ImageMagick magick for cover crop / optional generate sheet;
  codex_generate_image (openai-codex login) for cover art.
metadata:
  tags: uvid, episode, bilibili, edit-json, timeline, cover
---

# undefined-video

Produce one **episode directory** with uvid: three authored files
(`script.md`, `edit.json`, `bgm.mml`) plus mechanical filters that land
`program.mp4` / captions / optional `program.otio` / `cover.png`.

## When to load which reference

Read only the stage you need. Do not restart the whole pipeline if later
artifacts already exist and match the contracts.

| User intent | Read first | Then |
|---|---|---|
| New episode / full pipeline | this file → [script](references/script.md) | prep → edit → bgm → program → cover |
| Write or fix `script.md` only | [script](references/script.md) | stop unless they ask prep |
| Assets / normalize / ASR | [prep](references/prep.md) | |
| Build or revise cuts / subtitles / aroll | [edit](references/edit.md) + [edit schema](schemas/edit.schema.json) when validating shape | |
| Visual stills contact sheet (optional) | [edit](references/edit.md) (visual pass) | `uvid generate sheet` on stills |
| Compose / export BGM | [bgm](references/bgm.md) | export to **`clips/bgm.mp3`** |
| Package final `program.mp4` | [program](references/program.md) | |
| B 站封面 | [cover](references/cover.md) + palette from [themes](assets/themes.css) | ask style+content if missing |
| Theme colors / fonts | [themes](assets/themes.css) | hex only in image prompts; do not invent a second palette |

**Resume rule (primary decision, not a footnote):**

1. **Inspect first** — list what already exists under the episode root
   (`script.md`, `edit.json`, `timeline.*.json`, `program.mp4`, `cover.png`,
   `clips/*`, `cache/*`).
2. **Primary decision is skip / verify / run** — for the stage the user asked:
   - products exist **and** match contracts → **verify-only**, then stop
   - products missing or acceptance failed → run only that stage
   - later stages already complete and user did not ask to redo them → leave them alone
3. **Never rebuild by default** — do not re-normalize, re-ASR, re-export BGM,
   re-render packaging clips, or re-render `program.mp4` just because the user
   named that stage. Rebuild only when upstream input changed or a check failed.
4. **Report, then stop** when the asked stage is already satisfied. Do not
   center the reply on a full greenfield command list for work that is done.

**Not this skill:** freeform HyperFrames authoring, product launch reels,
PR videos, or “just burn SRT onto an mp4” with no uvid episode layout.

## Invocation

Every command has two equivalent forms over the same spec (flags never drift):

- **CLI:** `uvid <family> <action> -i … -o …` — kebab flags (`--from-ms`, `--sample-rate`)
- **pi tool:** `uvid_<family>_<action>` with a params object — camelCase (`fromMs`, `sampleRate`)

`-i`/`-o` ⇄ `input`/`output`. Binary `generate` needs `output`. `analyze` with no
`output` returns JSON in the tool result (same bytes CLI prints to stdout).

Concrete dual-form examples live in the stage references (prep / edit / program),
not here.

### In-session tool preferences

| Need | Prefer in pi | CLI fallback |
|---|---|---|
| ASR | `transcribe_media` → `cache/NN.asr.json` (`formats: ["json"]`) | `jianying-subtitle` |
| Cover image | `codex_generate_image` | (same tool; no local CLI) |
| Loudness / silence / frame evidence | `uvid_analyze_*` with no `output` | pipe stdout |
| Contact sheet of stills | `uvid_generate_sheet` | `uvid generate sheet` |

## Dependencies (fail fast)

Before a stage, ensure the tools that stage needs exist. Missing dep → tell the
user; do not invent a substitute pipeline.

| Stage | Requires |
|---|---|
| All | `uvid` (this package), Node ≥20 |
| Prep accept | `ffprobe` |
| Prep ASR | `transcribe_media` or `jianying-subtitle` |
| Prep scenes | HyperFrames available to `uvid generate scene/render` |
| Review | `mpv` |
| BGM export | FamiStudio (via `uvid generate bgm`) |
| Cover crop / sheet | ImageMagick `magick` |
| Cover art | `codex_generate_image` + openai-codex login |

## Project layout

One episode = one directory. Root holds only non-regenerable authored/captured
deliverables; rebuildable media stays under `clips/` / `cache/`.

```
<episode>/
├── script.md   edit.json   bgm.mml           # authored   ┐ tracked
├── raw/NN.ext                                 # captured   ┘
│
├── timeline.aroll.json   timeline.program.json
├── program.mp4   program.ass   program.otio
├── cover.png
│
├── clips/                    # persist: referenced at render time
│   ├── 01.media.*   01.visual.png
│   ├── intro.mp4  outro.mp4  tocN.mp4
│   ├── bgm.mp3               # exported bed (not root bgm.mp3)
│   └── dialog/               # idle/talk-closed/talk-open/wait-on.png
│
└── cache/                    # regenerable intermediates
    ├── NN.asr.json
    ├── scenes/
    ├── preview.aroll.mp4  preview.srt   # aroll: SRT only; ASS is program-pass
    └── stills / …
```

Suggested episode `.gitignore` line: `clips/` and `cache/`. Do not rewrite an
existing monorepo gitignore unless the user wants that.

## What lands on disk

Only files a later command reads with `-i` (or render-time external media) need
to land. One-shot decision evidence stays on stdout / tool result.

| Kind | Examples | On disk? |
|---|---|---|
| Downstream input | `asr.json` → edit; root `timeline.*.json` → video/captions/otio | Yes |
| Render media | normalized voice, clips, **`clips/bgm.mp3`**, dialog, visual | Yes |
| One-shot evidence | loudness / waveform / silence / frame-diff | No by default |

## Status model (`edit.json`)

Single meaning. Partial stage work must **not** jump ahead:

| status | Means | Who may set it |
|---|---|---|
| `subtitle-draft` | skeleton + subtitle pass in progress / just finished text layer | subtitle pass |
| `audio-reviewed` | audio/silence decisions done | audio pass |
| `video-reviewed` | visual holds resolved; **aroll accepted** | visual pass + human aroll OK |
| `ready` | **program (and cover if requested) human-accepted** | only after `program.md` review |

Rules:
- Subtitle-only work stays at `subtitle-draft` (never `ready`, never invent `hold_until`).
- Aroll acceptance = `video-reviewed`, **not** `ready`.
- `ready` only after program (and cover if in scope) human sign-off.
- Unresolved `check` actions block `ready`.
- If the on-disk file is already past the asked stage (e.g. `ready` while user
  only wants a subtitle plan), describe the **pass contract** without demoting
  status in a dry plan; when applying a pure re-pass, either start from skeleton
  or surgically touch only that stage’s actions.

## Pipeline map

| Stage | Doc |
|---|---|
| Script contract | [references/script.md](references/script.md) |
| Prep: packaging assets → normalize → ASR | [references/prep.md](references/prep.md) |
| Edit skeleton + sparse actions + aroll | [references/edit.md](references/edit.md) |
| BGM composition | [references/bgm.md](references/bgm.md) |
| Packaging → `program.mp4` | [references/program.md](references/program.md) |
| Cover (B 站 + theme; style/content from human) | [references/cover.md](references/cover.md) |
| Theme tokens | [assets/themes.css](assets/themes.css) |
| Machine contracts | [schemas/edit.schema.json](schemas/edit.schema.json), [schemas/timeline.schema.json](schemas/timeline.schema.json) |

Load schema files when validating or writing machine JSON — not on every turn.
For theme hex, prefer the table in `cover.md` or the matching `[data-theme]` block;
avoid dumping the entire CSS into context.
