# Edit: sparse editing intent (creative file 2/3)

**This is one of the three AI/human-authored creative files.** The other two are `script.md` and `bgm.mml`.

**Machine schema:** `schemas/edit.schema.json` (v0.1, `version: 0`)  
**Human contract notes:** may also exist per-episode as `edit-schema-v0.md` during discovery; the package schema is authoritative.

**Done means:** `edit.json` validates against the schema, review status is honest, and unresolved `check` actions are either fixed or status is not `ready`.

## Role

`edit.json` is **sparse intent**, not a timeline product.

- ASR transcript with stable ids is the base
- **Default is keep** — only write what should change
- Humans / AI write actions; tools do evidence + compile
- Do not create any edit format other than `edit.json`

## File location

```text
<episode>/
├── script.md
├── edit.json          # this file
├── raw/
├── cache/
│   └── <id>/
│       ├── normalized.*
│       ├── asr.json
│       └── visual.png   # audio sources
└── preview/             # ad-hoc compile outputs; not schema
```

## Generate skeleton

Atomic filter: ASR path(s) + explicit parallel metadata → upsert into `edit.json`.
No `script.md` parse, no cache directory scan.

**Equal-length multi-args** (comma-separated or repeated flags):

| flag | meaning |
|---|---|
| `-i` | ASR JSON path(s) |
| `--id` | source id(s) |
| `--type` | `audio` \| `video` per source |
| `--media` | media path(s) |
| `--visual` | optional still(s); same length if set; `-` = none |

```bash
# multi-source one shot
uvid generate edit \
  -i cache/01/asr.json,cache/02/asr.json \
  -o edit.json \
  --id 01,02 \
  --type audio,video \
  --media cache/01/normalized.mp3,cache/02/normalized.mp4 \
  --visual cache/01/visual.png,-

# single source still works
uvid generate edit \
  -i cache/02/asr.json \
  -o edit.json \
  --id 02 \
  --type video \
  --media cache/02/normalized.mp4
```

What it does:

- reads each ASR JSON, builds stable turn/word ids
- upserts those sources into `-o` edit.json
- new sources get `actions: []` (does **not** invent cuts)
- re-run same ids on same `-o` **preserves** those sources' actions
- other sources on the same `-o` are left intact
- unequal lengths → hard error

Who chooses paths? Agent/skill/shell from `script.md` + prep outputs — not this tool.

Optional metadata (only when creating a new file / missing fields):

```bash
--script script.md --title "…" --status subtitle-draft
```

## Minimal shape

```json
{
  "kind": "uvid.edit",
  "version": 0,
  "status": "subtitle-draft",
  "script": "script.md",
  "sources": [
    {
      "id": "02",
      "type": "video",
      "media": "cache/02/normalized.mp4",
      "asr": "cache/02/asr.json",
      "transcript": [],
      "actions": []
    }
  ]
}
```

Required root fields: `kind`, `version`, `status`, `sources`.

## Status machine

```text
subtitle-draft → audio-reviewed → video-reviewed → ready
```

| status | when |
|---|---|
| `subtitle-draft` | transcript + text/cut intent drafted |
| `audio-reviewed` | silence/waveform checked; audio range drops written |
| `video-reviewed` | frame-diff/frames checked; holds written |
| `ready` | no unresolved `check`; preview acceptable |

Any remaining `op: "check"` **blocks** `ready`.

## Source

| field | required | meaning |
|---|---|---|
| `id` | yes | source id from `script.md` / `cache/<id>` |
| `type` | yes | `audio` \| `video` |
| `media` | yes | normalized media path for compile |
| `asr` | yes | ASR json path |
| `transcript` | yes | ASR snapshot with stable ids |
| `actions` | yes | sparse decisions (may be empty) |
| `visual` | no | still for audio sources, e.g. `cache/01/visual.png` |

## Transcript ids

Turn:

```text
s<sourceId>-t<turnIndex3>     e.g. s02-t011
```

Word:

```text
s<sourceId>-t<turnIndex3>-w<wordIndex3>   e.g. s02-t010-w000
```

Ids are anchors only. Cutting rules live in `actions`.

## Actions

### Common fields

| field | required | meaning |
|---|---|---|
| `id` | yes | unique within source, e.g. `a02-005` |
| `target` | yes | what it applies to |
| `op` | yes | see ops below |
| `track` | no | `audio` \| `video` \| `both` (default `audio`) |
| `kind` | no | why label |
| `reason` | no | human note |
| `stage` | no | `subtitle` \| `audio` \| `video` |
| `evidence` | no | freeform paths/metrics from atomic tools |

### `target` forms

```json
"s02-t011"
```

```json
["s01-t002", "s01-t003"]
```

```json
{ "startMs": 24330, "endMs": 31936 }
```

- turn/word id for speech units
- array for multi-target same op
- **range is first-class** for lead/trail/gaps/internal silence/non-speech video leftovers

### Ops (closed set, v0.1)

| op | track | meaning |
|---|---|---|
| `drop` | audio / video / both | remove from selected track(s) |
| `keep` | audio / video / both | explicit keep; override broader drop |
| `replace_text` | text layer | correct display text only; **does not cut** |
| `hold_until` | **video only** | keep video from target speech start through `untilMs` |
| `check` | any | unresolved; blocks `ready` |

Do **not** add new ops casually. Soft cuts (edge snap / afade) are **compile defaults**, not edit fields.

Op-specific required fields:

- `replace_text` → `text`
- `hold_until` → `untilMs` and `track: "video"`

### `replace_text` timing (karaoke / mouth axis)

Captions and dialog mouth both consume `captions[].words` on the program axis.
**Prefer preserving ASR word timings** over letting timeline re-tokenize.

Priority when authoring:

1. **Word-level replace** (best): target `sXX-tYYY-wZZZ`, only change that token's surface. Times stay on the ASR word.
2. **Turn-level replace + `words[]`** (when the whole line must change): include source-axis `words: [{text,startMs,endMs}, …]` on the action. Timeline **trusts and projects** them — no rebuild.
3. **Turn-level replace with only `text`** (fallback): timeline re-tokenizes and redistributes the old span. Easy to get coarse karaoke (esp. spaced CJK+Latin lines). Avoid for product typewriter.

Rules for skill agents writing turn-level `words[]`:

- Times are **source/ASR axis** (same as transcript), not program/packaged axis.
- Reuse old word `startMs`/`endMs` whenever the spoken slot is the same; only rewrite `text` (e.g. `granulexed` → `GNU/Linux`).
- Keep tokens fine enough for typewriter: CJK prefer word/char pieces; keep Latin runs like `GNU/Linux` as one token.
- Cover the turn window; do not invent times far outside ASR speech.
- Do **not** invent a waveform/VAD pass by default — inherit ASR axis first.

### Recommended `kind` values

```text
filler | repetition | false_start | mistake | asr_error | pause | visual_action
```

Open string; unknown kinds must not break compile.

## Layer rules

| layer | ops | effect |
|---|---|---|
| time / media | `drop`, `keep`, `hold_until` | what remains on A/V |
| text | `replace_text` | captions / corrected transcript |

Valid patterns:

1. `replace_text` only — keep spoken audio, fix caption
2. audio `drop` + video `hold_until` on related content — mute picture hold is OK
3. imperfect speech kept for timing + `replace_text` to intended line + hold result screen

**Never treat `replace_text` as a cut.**

For typewriter product: when fixing ASR, either target the wrong **word id**, or turn-level replace with authored **`words[]`**. Bare turn `text` without words is preview-grade only.

## Review workflow

Use atomic tools; do not invent a monolithic validator.

```text
1. subtitle-draft
   - build transcript ids from cache/<id>/asr.json
   - drop fillers / false starts / pure waste
   - replace_text for ASR errors

2. audio-reviewed
   - uvid analyze silence / waveform
   - range-drop lead/trail/gaps
   - mark internal silence as check if unsure

3. video-reviewed
   - uvid analyze frame-diff for video sources
   - inspect actual frames around change points
   - hold_until for command results / screen info
   - video drop trail after holds

4. ready
   - resolve or drop remaining checks
   - preview listen/look pass
```

Hard rule from real footage:

> Do not drop a turn only because ASR text is garbage.  
> Look at frames. If the screen shows the intended command/result, keep timing, `replace_text`, and `hold_until`.

## Compile projection (intent → geometry)

Command: `uvid generate timeline -i edit.json -o timeline.json`.
Schema: `schemas/timeline.schema.json` (`kind: uvid.timeline`).

Per source (rebuildable from `edit.json`, not a hand-edited lock):

1. audio drops → merge → `audio_kept = media − drops` (keep overrides drop)
2. discard audio shards shorter than `minAudioShardMs` (default 120)
3. video starts from `audio_kept`, union `hold_until` spans, subtract video drops
4. hold extends picture only; audio follows audio drop/keep only
5. collapse source-internal gaps on the program axis
6. audio sources paint still under kept audio (`picture: still`); video uses media frames
7. `replace_text` → captions map on program axis (no cut)
8. captions include **word-level** program times for final RPG typewriter; preview SRT uses turn text
   - if turn-level `replace_text.words[]` present → project those (trusted)
   - else ASR words + word-level surface replaces
   - else rebuild/re-tokenize fallback from turn text
9. `check` → unresolved list (geometry unchanged)

Soft-cut defaults applied at compile (not edit fields):

- default edge afade 16ms; high-risk (≥1s collapsed source gap) 32ms
- no speech crossfade
- near-end range drop snap ≤500ms to media end
- clamp ranges to media duration

### Packaging (timeline, not video)

Packaging is inserted by `generate timeline`, not by `generate video`:

```bash
uvid generate timeline -i edit.json -o timeline.json \
  --intro clips/intro.mp4 \
  --outro clips/outro.mp4 \
  --toc-before 02,04 \
  --toc-titles '第二章,收尾'
```

- `--intro` / `--outro` = **explicit media paths** (duration + audio probed; no default file, no boolean placeholder)
- TOC via explicit `--toc-before ID,ID,…` (+ optional `--toc-titles`); never scan dirs or re-read `script.md`
- Unbound TOC slots stay black+silence placeholders until media is supplied later

### Downstream (all single-stream from timeline)

Bind assets at timeline compile (`--intro/--outro/--toc/--dialog/--bgm/--fg/...`). Then:

```bash
# Episode mp4 — only timeline + render presets (quality/fps/size)
uvid generate video -i timeline.program.json -o out.mp4 --quality draft

# Typewriter ASS from captions[].words (product); SRT is turn-level preview
uvid generate captions -i timeline.program.json -o out.ass
uvid generate captions -i timeline.program.json -o out.srt

# NLE interchange (uses same timeline-bound assets)
uvid generate otio -i timeline.program.json -o out.otio
```

Boundary: `generate render` remains scene-dir → single media. Episode assemble is `generate video` reading **only** `timeline.json`.

## What not to do

- Do not freeze a second parallel schema in episode notes that contradicts `schemas/edit.schema.json`
- Do not create a `draft.json` or any parallel edit artifact
- Do not write OTIO / final NLE timeline into `edit.json` (export via `generate otio` from timeline)
- Do not require hand-written padMs / soften fields for normal cuts
- Do not mark `ready` while `check` actions remain

## Tiny worked example

```json
{
  "kind": "uvid.edit",
  "version": 0,
  "status": "video-reviewed",
  "script": "script.md",
  "sources": [
    {
      "id": "02",
      "type": "video",
      "media": "cache/02/normalized.mp4",
      "asr": "cache/02/asr.json",
      "transcript": [
        {
          "id": "s02-t011",
          "text": "比如LS杠A",
          "startMs": 20090,
          "endMs": 21650,
          "words": []
        },
        {
          "id": "s02-t012",
          "text": "他的应该是杠然后",
          "startMs": 22090,
          "endMs": 24330,
          "words": []
        }
      ],
      "actions": [
        {
          "id": "a02-004",
          "target": "s02-t011",
          "track": "audio",
          "op": "replace_text",
          "kind": "asr_error",
          "text": "比如 ls -a",
          "stage": "subtitle",
          "words": [
            { "text": "比如", "startMs": 20090, "endMs": 20500 },
            { "text": "ls", "startMs": 20500, "endMs": 21100 },
            { "text": "-a", "startMs": 21100, "endMs": 21650 }
          ]
        },
        {
          "id": "a02-005",
          "target": "s02-t012-w002",
          "track": "audio",
          "op": "replace_text",
          "kind": "asr_error",
          "text": "ls -l",
          "stage": "subtitle",
          "reason": "prefer word-level when only one token is wrong"
        },
        {
          "id": "a02-013",
          "target": { "startMs": 24330, "endMs": 31936 },
          "track": "audio",
          "op": "drop",
          "kind": "pause",
          "stage": "audio"
        },
        {
          "id": "a02-023",
          "target": "s02-t012",
          "track": "video",
          "op": "hold_until",
          "kind": "visual_action",
          "untilMs": 28500,
          "stage": "video"
        }
      ]
    }
  ]
}
```

## Validate

Against package schema:

```bash
# from package root; requires ajv
node --input-type=module -e '
import {readFileSync} from "fs";
import Ajv2020 from "ajv/dist/2020.js";
const s=JSON.parse(readFileSync("schemas/edit.schema.json","utf8"));
const d=JSON.parse(readFileSync("<episode>/edit.json","utf8"));
const v=new Ajv2020({allErrors:true,strict:false}).compile(s);
console.log(v(d)?"VALID":v.errors);
'
```
