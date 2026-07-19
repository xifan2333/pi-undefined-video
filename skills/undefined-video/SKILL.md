---
name: undefined-video
description: >
  Episode video production with pi-undefined-video (uvid): script.md → normalize/ASR
  → sparse edit.json → aroll/program timeline → program.mp4 + Bilibili cover.png.
  Use whenever the user mentions uvid, pi-undefined-video, 做一期视频/口播成片,
  edit.json, sparse cuts, timeline.aroll/program, program.mp4, bgm.mml, B 站封面,
  the full episode pipeline (raw clips → packaged deliverable), or partial steps
  (ASR, subtitle pass, packaging, cover). Also use for freeform packaging inserts
  inside a uvid episode after aroll is accepted (custom motion mp4 or static-frame
  png as source.visual): agent-authored HyperFrames scene dirs + uvid_generate_render
  only — never uvid_generate_scene for freeform. Do NOT use for whole freeform
  HyperFrames videos with no uvid episode layout, product-launch promos, PR
  explainers, or plain subtitle burn-in on a finished mp4 without uvid layout.
license: MIT
compatibility: >
  Node >=20; uvid tools from this package; ffmpeg/ffprobe; mpv for review; ASR via
  pi tool transcribe_media; HyperFrames only as the backend of uvid_generate_scene /
  uvid_generate_render; FamiStudio for uvid_generate_bgm; ImageMagick magick for
  cover crop / optional uvid_generate_sheet; codex_generate_image (openai-codex
  login) for cover art.
metadata:
  tags: uvid, episode, bilibili, edit-json, timeline, cover
---

# undefined-video

Produce one **episode directory** with uvid: three authored files
(`script.md`, `edit.json`, `bgm.mml`) plus mechanical filters that land
`program.mp4` / captions / optional `program.otio` / `cover.png`.

## Path rules (read first)

**Prefer absolute paths everywhere.** Relative paths are the main source of agent
mistakes (skill dir vs episode cwd).

Two roots — do not mix them.

| Kind | Root | How to open / pass |
|---|---|---|
| **Skill docs / contracts** | directory that contains this `SKILL.md` | `read` / open with **absolute** paths: `<SKILL_DIR>/references/…`, `<SKILL_DIR>/schemas/…`, `<SKILL_DIR>/assets/themes.css` |
| **Episode work products** | episode project root (`process.cwd()` for `uvid_*`) | tool `input`/`output` with **absolute** paths under the episode: `<EPISODE>/clips/…`, `<EPISODE>/cache/…`, `<EPISODE>/edit.json`, … |

### Skill docs

1. Resolve `SKILL_DIR` = absolute parent of this file (the path you used to load
   `SKILL.md`, or the skill’s installed path under the package).
2. Stage docs are only under that root. Examples (literal pattern, not cwd-relative):
   - `<SKILL_DIR>/references/prep.md`
   - `<SKILL_DIR>/references/edit.md`
   - `<SKILL_DIR>/schemas/edit.schema.json`
   - `<SKILL_DIR>/assets/themes.css`
3. **Never** `read` `references/…` or `schemas/…` as a path relative to the episode.

### Episode media / tool I/O

1. Resolve `EPISODE` = absolute episode directory (user project / episode root).
2. When calling `uvid_*` / `transcribe_media` / `codex_generate_image`, pass
   **absolute** paths under `EPISODE` for every `input` / `output` / media field.
3. Runtime still resolves relatives against `process.cwd()`, but agents must not
   rely on that — always expand to absolute before the tool call.
4. Package templates (`templates/`) are internal to the package (`packageRoot()`);
   do not invent skill-dir or episode paths for them.

Tool examples use **absolute** `input`/`output` (and media fields) as
`<EPISODE>/…`. Do not pass cwd-relative paths for tool I/O.

## When to load which reference

Read only the stage you need. Do not restart the whole pipeline if later
artifacts already exist and match the contracts.

| User intent | Read first (absolute under `SKILL_DIR`) | Then |
|---|---|---|
| New episode / full pipeline | this file → `<SKILL_DIR>/references/script.md` | prep → edit → bgm → program → cover |
| Write or fix `script.md` only | `<SKILL_DIR>/references/script.md` | stop unless they ask prep |
| Assets / normalize / ASR | `<SKILL_DIR>/references/prep.md` | |
| Freeform HyperFrames insert (no `generate scene`) | `<SKILL_DIR>/references/freeform.md` | only when `video-reviewed`; **motion** `.mp4` (packaging) or **static frame** `.png` (`source.visual`); never during prep/edit cut |
| Build or revise cuts / subtitles / aroll | `<SKILL_DIR>/references/edit.md` + `<SKILL_DIR>/schemas/edit.schema.json` when validating shape | |
| Visual stills contact sheet (optional) | `<SKILL_DIR>/references/edit.md` (visual pass) | `uvid_generate_sheet` on stills |
| Compose / export BGM | `<SKILL_DIR>/references/bgm.md` | export to **`<EPISODE>/clips/bgm.mp3`** |
| Package final `program.mp4` | `<SKILL_DIR>/references/program.md` | |
| B 站封面 | `<SKILL_DIR>/references/cover.md` + `<SKILL_DIR>/assets/themes.css` | ask style+content if missing |
| Theme colors / fonts | `<SKILL_DIR>/assets/themes.css` | hex only in image prompts; do not invent a second palette |

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

**Not this skill:** whole freeform HyperFrames videos outside a uvid episode
layout; product launch reels; PR explainers; or “just burn SRT onto an mp4” with
no uvid episode layout. Freeform **inserts** after `video-reviewed` (motion mp4
or static-frame png) **are** in scope — see
`<SKILL_DIR>/references/freeform.md`.

## Invocation (pi tools only)

In-session, drive every mechanical step with **pi tools**. Do not shell out to
`uvid …` CLI from this skill.

| Need | Tool | Notes |
|---|---|---|
| Stock scene project | `uvid_generate_scene` | intro/outro/toc/markdown/dialog only → `cache/scenes/` |
| Freeform scene HTML | agent `write` | HyperFrames dir under `cache/scenes/`; **no** `uvid_generate_scene` |
| Render scene | `uvid_generate_render` | stock or freeform; omit/mp4 = motion (length ← HTML `data-duration` → probed file on timeline); `png` = static frame (`atMs`, held by speech); `sprite` = dialog |
| Loudness normalize | `uvid_generate_normalize` | requires `lufs` / `tp` / `lra` |
| Loudness / waveform / silence / frame-diff | `uvid_analyze_*` | omit `output` → JSON in tool result |
| Still frame | `uvid_generate_frame` | requires `atMs` |
| Contact sheet | `uvid_generate_sheet` | |
| Skeleton `edit.json` | `uvid_generate_edit` | parallel arrays equal length |
| Timeline | `uvid_generate_timeline` | packaging flags → `basis=program` |
| Captions | `uvid_generate_captions` | `format`: `srt` \| `ass` |
| Final / preview video | `uvid_generate_video` | |
| OTIO | `uvid_generate_otio` | optional |
| BGM bed | `uvid_generate_bgm` | write **`clips/bgm.mp3`** |
| ASR | `transcribe_media` | `formats: ["json"]` → `cache/NN.asr.json` |
| Cover art | `codex_generate_image` | then crop to `cover.png` |

Params are **camelCase** (`fromMs`, `sampleRate`, `tocBefore`). Path fields are
`input` / `output` (same role as CLI `-i`/`-o`) — always **absolute** under
`EPISODE`. Same for `media` / `visual` / packaging paths (`intro`, `outro`,
`toc`, `bgm`, `dialog`). Binary `generate` needs `output`. `analyze` with no
`output` returns JSON in the tool result.

Concrete call shapes live under `<SKILL_DIR>/references/` (prep / edit / program /
bgm / cover). Substitute the real episode root for `<EPISODE>`.

## Dependencies (fail fast)

Before a stage, ensure the tools that stage needs exist. Missing dep → tell the
user; do not invent a substitute pipeline.

| Stage | Requires |
|---|---|
| All | this package’s `uvid_*` tools, Node ≥20 |
| Prep accept | `ffprobe` |
| Prep ASR | `transcribe_media` |
| Prep scenes | HyperFrames available to `uvid_generate_scene` / `uvid_generate_render` |
| Review | `mpv` |
| BGM export | FamiStudio (via `uvid_generate_bgm`) |
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

Only files a later tool reads as `input` (or render-time external media) need
to land. One-shot decision evidence stays in the tool result.

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

| Stage | Doc (absolute under `SKILL_DIR`) |
|---|---|
| Script contract | `<SKILL_DIR>/references/script.md` |
| Prep: packaging assets → normalize → ASR | `<SKILL_DIR>/references/prep.md` |
| Edit skeleton + sparse actions + aroll | `<SKILL_DIR>/references/edit.md` |
| BGM composition | `<SKILL_DIR>/references/bgm.md` |
| Packaging → `program.mp4` | `<SKILL_DIR>/references/program.md` |
| Freeform motion / static inserts | `<SKILL_DIR>/references/freeform.md` |
| Cover (B 站 + theme; style/content from human) | `<SKILL_DIR>/references/cover.md` |
| Theme tokens | `<SKILL_DIR>/assets/themes.css` |
| Machine contracts | `<SKILL_DIR>/schemas/edit.schema.json`, `<SKILL_DIR>/schemas/timeline.schema.json` |

Load schema files when validating or writing machine JSON — not on every turn.
For theme hex, prefer the table in cover.md or the matching `[data-theme]` block;
avoid dumping the entire CSS into context.
