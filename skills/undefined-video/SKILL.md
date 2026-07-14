---
name: undefined-video
description: >
  Episode video production with pi-undefined-video (uvid).
---

# undefined-video

## Invocation

Every command has two equivalent forms over the same spec (so flags never drift):

- **CLI:** `uvid <family> <action> -i … -o …` — kebab flags (`--from-ms`, `--sample-rate`).
- **pi tool:** `uvid_<family>_<action>` with a params object — camelCase keys (`fromMs`, `sampleRate`).

`-i`/`-o` ⇄ `input`/`output`. A binary `generate` needs `output`; an `analyze` called
with no `output` returns its JSON in the tool result (the same bytes CLI prints to stdout).
Examples below give both forms.

## Project layout

One episode = one directory. The root holds only what cannot be regenerated
(authored + captured + delivered); everything else is rebuildable.

```
<episode>/
├── script.md   edit.json   bgm.mml           # authored artifacts   ┐ tracked
├── raw/NN.ext                                 # captured source (NN = source id) ┘
│
├── timeline.aroll.json   timeline.program.json  # compiled timeline (root; media paths resolve here)
├── program.mp4   program.ass   program.otio    # deliverables (root)
│
├── clips/                                      # media referenced by otio/video → must persist
│   ├── 01.media.mp3   01.visual.png
│   ├── intro.mp4  outro.mp4  toc1.mp4
│   ├── bgm.mp3
│   └── dialog/                                 # sprite: idle/talk-closed/talk-open/wait-on.png
│
└── cache/                                      # intermediate files read by a later -i → regenerable
    ├── 01.asr.json
    ├── scenes/
    ├── preview.aroll.mp4  preview.srt  preview.ass
    └── [optional] stills / silence dumps …
```

`.gitignore` is one line: `clips/ cache/`.

## What lands on disk (and what doesn't)

> Only files that a later command reads with `-i` need to land. Evidence you read
> once to make a decision goes to stdout, not a file.

| Kind | Examples | On disk? |
|---|---|---|
| Input to a downstream command | `asr.json` (→ edit), root `timeline.*.json` (→ video/captions/otio) | Yes — read by `-i` |
| Media referenced at render time | normalized voice, clips, bgm, dialog, visual | Yes — external reference |
| One-shot decision evidence | `analyze loudness/waveform/silence/frame-diff` | No by default — pipe it |

## Pipeline (references)

| Stage | Doc |
|---|---|
| Script contract | `references/script.md` |
| Prep: packaging assets → normalize → ASR | `references/prep.md` |
| Edit skeleton + sparse actions + aroll review | `references/edit.md` |
| BGM composition | `references/bgm.md` |
| Packaging → `program.mp4` | `references/program.md` |
| Machine contracts | `schemas/edit.schema.json`, `schemas/timeline.schema.json` |
