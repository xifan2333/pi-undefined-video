# edit.json — sparse editing intent (creative file 2/3)

**One of the three authored artifacts.** The other two are `script.md` and `bgm.mml`.

`edit.json` is where cutting happens. The transcript (from ASR) is the base and
**every turn defaults to keep** — you never list what to keep. You only record the
sparse **actions** that change something (drop a turn, fix its text, hold a gap,
flag a doubt). This keeps the file small and the intent explicit.

Machine-exact contract: absolute `<SKILL_DIR>/schemas/edit.schema.json` (not under
the episode). Shape at a glance:

```jsonc
{
  "kind": "uvid.edit",
  "version": 0,
  "status": "subtitle-draft",          // subtitle-draft | audio-reviewed | video-reviewed | ready
  "script": "script.md",
  "sources": [                          // compile order follows this array
    {
      "id": "01",
      "type": "audio",                  // audio | video
      "media": "clips/01.media.mp3",    // episode-relative in the file
      "asr": "cache/01.asr.json",
      "visual": "clips/01.visual.png",  // audio sources only; omit for video
      "transcript": [ /* turns with stable ids, default keep */ ],
      "actions": [ /* sparse cut decisions — empty until you edit */ ]
    }
  ]
}
```

Turn/word ids are stable and assigned by the tool: `s<id>-t<NNN>` and
`s<id>-t<NNN>-w<NNN>` (e.g. `s01-t000`, `s01-t000-w000`).

On-disk `edit.json` keeps **episode-relative** `media`/`asr`/`visual`. Tool `input`/`output` (and arrays passed to `uvid_generate_edit`) use **absolute** `<EPISODE>/…`.

## Build the skeleton — `uvid_generate_edit`

**Done means:** `edit.json` holds every source in script order, each with its
`transcript` populated and `actions` empty, ready for editing.

`uvid_generate_edit` reads the ASR JSON(s), assigns stable ids, and upserts sources
into `edit.json`. It **does not invent cuts** and **does not parse `script.md`** —
you pass the mapping explicitly. Re-running preserves each source's existing
`actions` and any sources you don't pass, so it is safe to re-run after adding
media/ASR.

The parallel arrays `input` / `id` / `type` / `media` (and optional `visual`) must
be equal length. `type` and `visual` follow the script tag: `<audio>` → `audio`
with a `.visual.png` still; `<video>` → `video` with `"-"` (no still).

```jsonc
// uvid_generate_edit  (arrays, equal length; visual "-" = none)
{
  "input":  ["<EPISODE>/cache/01.asr.json", "<EPISODE>/cache/02.asr.json", "<EPISODE>/cache/03.asr.json", "<EPISODE>/cache/04.asr.json", "<EPISODE>/cache/05.asr.json"],
  "output": "<EPISODE>/edit.json",
  "id":     ["01", "02", "03", "04", "05"],
  "type":   ["audio", "video", "video", "audio", "audio"],
  "media":  ["<EPISODE>/clips/01.media.mp3", "<EPISODE>/clips/02.media.mp4", "<EPISODE>/clips/03.media.mp4", "<EPISODE>/clips/04.media.mp3", "<EPISODE>/clips/05.media.mp3"],
  "visual": ["<EPISODE>/clips/01.visual.png", "-", "-", "<EPISODE>/clips/04.visual.png", "<EPISODE>/clips/05.visual.png"],
  "script": "<EPISODE>/script.md"
}
```

### Accept

- `kind: "uvid.edit"`, `version: 0`, sources in script order.
- Every source has the required keys `id / type / media / asr / transcript / actions`.
- `transcript` is populated (turns with ids); `actions` is empty (no cuts invented).
- `audio` sources carry `visual`; `video` sources do not.

### Checklist

- [ ] Every script source is present, in script order.
- [ ] Each `type`/`visual` matches its script tag (`<audio>`+still / `<video>`+`-`).
- [ ] `media` points at the normalized `clips/NN.media.*`; `asr` at `cache/NN.asr.json`.
- [ ] `actions` empty — the skeleton is ready to edit.

## Actions contract

Sparse only: default is keep. Each action:

| field | role |
|---|---|
| `id` | unique in source, e.g. `a02-007` |
| `op` | `drop` \| `keep` \| `replace_text` \| `hold_until` \| `check` |
| `target` | unit id / id[] / `{startMs,endMs}` (source media axis) |
| `track` | `audio` \| `video` \| `both` (default `audio`; `hold_until` is `video`) |
| `stage` | `subtitle` \| `audio` \| `video` — which pass authored it |
| `kind` | open string; prefer `filler` `repetition` `false_start` `mistake` `asr_error` `pause` `visual_action` |
| `reason` / `evidence` | human note + optional freeform pointers |

### Compile model (`uvid_generate_timeline`)

```
audio_kept = invert(audio drops − keeps)
video_kept = (audio_kept ∪ hold_until) − video drops
```

Lead / trail / inter-turn gaps **stay** unless you drop them. Captions ride on
kept speech only.

| op | effect |
|---|---|
| `drop` unit | cut media for `track`; **word-level drop also removes that word from caption text/words** (no re-tokenize) |
| `drop` range | cut that media window on `track` |
| `replace_text` | text layer only; **always word-level** so karaoke `\k` timings stay |
| `hold_until` | keep **video** from target speech start through `untilMs` while audio may be silent |
| `keep` | subtract from drops — **do not** use it to “save picture across an audio drop” (it re-admits dropped speech+captions). Use `hold_until` |
| `check` | unresolved flag; blocks `status: ready` |

### Granularity

- **Word-level:** fillers (`嗯`/`呃`), ASR fixes, CJK↔Latin spacing (embed the space **on the English word surface**, e.g. `" ls"`, `" ls -a"`, `"Cheat"`+`" Sheet "`, `" GNU/Linux "`).
- **Turn-level `drop`:** residual / meta / false-start sentences with no useful words.
- **Never turn-level `replace_text`** unless you also author `words[]` (reuses ASR starts/ends). Prefer word replace — turn-level replace without `words[]` re-tokenizes and redistributes karaoke time.
- Creative whole-turn drops (meta openers you *might* keep as bridges) → propose, human confirms. Objective typos/fillers → apply directly.

Chinese–English boundary always has a space: `命令 ls`, `GNU/Linux 社区`.

**ASS typewriter paints `words[]`, not `text`.** SRT can look correct while ASS has no spaces if word surfaces lost them. After subtitle edits, confirm `join(words[].text) === caption.text` (timeline keeps this when replaces stay word-level).

## Edit pass order

Status advances as you finish each pass:
`subtitle-draft` → `audio-reviewed` → `video-reviewed` → `ready`.

`ready` is reserved for post-program human sign-off (`<SKILL_DIR>/references/program.md`).
Finishing the visual pass and accepting aroll → `video-reviewed`, not `ready`.

**Partial-pass discipline:** a subtitle-only request authors only `stage: "subtitle"`
speech actions (`replace_text` / turn or word `drop`). Do **not** invent
`hold_until`, silence range drops, or status jumps. Leave status at
`subtitle-draft` for that pass. If on-disk `edit.json` already mixes later stages
(or is `ready`), describe the subtitle contract without rewriting the whole file
in a dry plan; when applying, either start from a skeleton or touch only subtitle
actions.

### 1. Subtitle (`stage: "subtitle"`)

Read `transcript` + script intent. Fix text first, cut media as needed for speech:

1. Word-level `replace_text` (typos, casing, CJK–Latin spaces).
2. Word-level `drop` fillers.
3. Turn-level `drop` residual / pure-meta sentences (creative ones: confirm first).

Do **not** invent silence cuts here — only speech units.

### 2. Audio re-verify (`stage: "audio"`)

Evidence — write waveform to cache, then silence (no shell pipe):

```jsonc
// uvid_analyze_waveform
{ "input": "<EPISODE>/clips/02.media.mp4", "output": "<EPISODE>/cache/02.waveform.json" }
// uvid_analyze_silence  (≥400ms typical)
{ "input": "<EPISODE>/cache/02.waveform.json", "minMs": 400 }
// omit silence output → ranges JSON in the tool result
```

Use silence to:

1. Confirm cut edges land in pauses.
2. Inventory **long silences** (lead / internal / trail) as candidates for the visual pass — long quiet is evidence about whether the **picture** still carries info, not just hygiene.
3. Drop pure non-speech windows you never want:
   - audio sources / empty picture: `track:"both"` range drop
   - video sources with possible on-screen info: `track:"audio"` range drop + `hold_until` on the last kept word so picture stays for step 3

Trail silence after the last kept turn is already excluded by the kept-turn model; internal long gaps are the important ones.

### 3. Visual re-verify (`stage: "video"`)

**Principle — information compare, picture first:**

| picture | sound | action |
|---|---|---|
| info | info | keep both |
| none | none | `drop` both |
| info | none | drop audio, keep picture (`hold_until`) |
| none | info | keep sound; **supplement picture** (usually a `script.md` design gap) |

For each held long gap: sample stills (and optional frame-diff) and decide.

```jsonc
// uvid_analyze_frame-diff
{ "input": "<EPISODE>/clips/02.media.mp4", "fromMs": 21650, "toMs": 31936 }
// uvid_generate_frame
{ "input": "<EPISODE>/clips/02.media.mp4", "atMs": 21800, "output": "<EPISODE>/cache/stills/02_21800.jpg" }
```

Optional: contact-sheet many stills before deciding holds:

```jsonc
// uvid_generate_sheet
{ "paths": ["<EPISODE>/cache/stills/02_21800.jpg"], "output": "<EPISODE>/cache/stills/02.sheet.jpg", "tile": "4x2" }
```

Not required; use when stills are numerous.

Resolve provisional holds: shorten `untilMs` to the last informative frame, then
`drop` the static remainder with `track:"both"` + `stage:"video"`.
Do **not** add `keep` actions to mark “picture is good”.

### 4. Rough cut + human review

Timeline at **episode root** (media paths resolve from there):

```jsonc
// uvid_generate_timeline
{ "input": "<EPISODE>/edit.json", "output": "<EPISODE>/timeline.aroll.json" }
// uvid_generate_captions
{ "input": "<EPISODE>/timeline.aroll.json", "output": "<EPISODE>/cache/preview.srt", "format": "srt" }
// uvid_generate_video
{ "input": "<EPISODE>/timeline.aroll.json", "output": "<EPISODE>/cache/preview.aroll.mp4", "quality": "draft" }
// then review externally: mpv --sub-file=cache/preview.srt cache/preview.aroll.mp4
```

Aroll preview is **SRT only** (external sub for cut review). No ASS / no
theme burn-in here — typewriter style + theme colors belong on the
program pass (`<SKILL_DIR>/references/program.md` → `program.ass` + burn-in).

Accept: captions clean (spaces on SRT, no fillers), cuts on pauses,
V-only holds only where the screen still informs, duration matches intent.
Fix by editing `actions` and regenerating — never hand-patch the mp4.

Aroll is the body-cut review path. Packaging → final deliverable is
`<SKILL_DIR>/references/program.md` (`timeline.program.json` + `program.mp4`).

**Do not freeform-render yet.** Custom HyperFrames inserts wait until aroll is
accepted (`status: video-reviewed`). Cut still moves duration, chapters, and
picture; early freeform wastes renders or locks stale art. Stock prep
intro/outro/toc/markdown/dialog are fine early.

**After `video-reviewed`:** freeform motion (`.mp4` packaging) or static frame
(`.png` as `source.visual`) → `<SKILL_DIR>/references/freeform.md`. Prefer stock
markdown visual when enough. Freeform = agent `write` + `uvid_generate_render`
only — **never** `uvid_generate_scene`.

### Checklist

- [ ] Subtitle: word-level replace/drop done; meta turns confirmed or dropped.
- [ ] CJK–Latin spaces live on word surfaces (program ASS karaoke will show them).
- [ ] Audio: lead/trail/internal non-speech decided; long gaps held or dropped.
- [ ] Video: every hold justified by picture info; static tails dropped.
- [ ] `timeline.aroll.json` at root; preview mp4 + `cache/preview.srt` reviewed in mpv.
- [ ] No unresolved `check`; aroll accepted → `status: video-reviewed`; then package per `program.md`. Set `status: ready` only after program (and cover if requested) human sign-off.
