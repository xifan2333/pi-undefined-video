# Prep: stable front-loaded workflow

Prep turns the `raw/NN.ext` media referenced by `script.md` into the basic assets needed for later AI editing.

The current stable prep scope has only four steps:

```text
1. Read script.md
2. Normalize raw media into cache/<id>/normalized.*
3. Run ASR with transcribe_media into cache/<id>/asr.*
4. Generate static visuals for <audio> blocks
```

Do not make editing decisions during prep.

## Directory convention

```text
<episode>/
├── script.md
├── raw/
│   ├── 01.mp4
│   └── ...
├── cache/
│   ├── 01/
│   │   ├── normalized.mp3
│   │   ├── asr.json
│   │   ├── asr.srt
│   │   ├── asr.txt
│   │   ├── visual.md      # audio source only
│   │   ├── scene/         # audio source only, optional render source
│   │   └── visual.png     # audio source only
│   └── 02/
│       ├── normalized.mp4
│       ├── asr.json
│       ├── asr.srt
│       └── asr.txt
└── clips/
```

Use `cache/<source-id>/...`, not `cache/<artifact-kind>/<id>...`.

## Step 1: read script.md

Read `script.md` directly. Do not call an `analyze script` tool.

Extract every media tag:

```html
<audio src="raw/NN.ext"></audio>
<video src="raw/NN.ext"></video>
```

Rules:

- `NN` is the source id.
- `<audio>` means later editing is audio-only; its picture comes from markdown/static visuals.
- `<video>` means later editing must consider both sound and picture.
- Preserve source order from `script.md`.

## Step 2: normalize

Create the source cache directory first:

```bash
mkdir -p cache/NN
```

For `<audio>` sources, output audio-only MP3:

```bash
uvid generate normalize \
  -i raw/NN.ext \
  -o cache/NN/normalized.mp3 \
  --lufs -16 --tp -1.5 --lra 11
```

For `<video>` sources, keep video in MP4 and normalize audio:

```bash
uvid generate normalize \
  -i raw/NN.ext \
  -o cache/NN/normalized.mp4 \
  --format mp4 \
  --lufs -16 --tp -1.5 --lra 11
```

Do not write normalized prep media to `clips/`. `clips/` is for later timeline/deliver assets.

## Step 3: ASR

Use the separate JianYing subtitle plugin tool `transcribe_media`.

For each normalized source, write all three formats:

```text
cache/NN/asr.json
cache/NN/asr.srt
cache/NN/asr.txt
```

Tool call shape:

```text
transcribe_media(
  input:  "cache/NN/normalized.mp3" or "cache/NN/normalized.mp4",
  output: "cache/NN/asr",
  formats: ["json", "srt", "txt"]
)
```

Request `json` because later editing needs word/segment timing.

## Step 4: static visuals for audio blocks

For each `<audio>` source, extract that media block's markdown body from `script.md`:

- Remove the `<audio ...></audio>` tag.
- Keep the surrounding markdown content in that `---` block.
- Write it to:

```text
cache/NN/visual.md
```

Then generate a static visual from `visual.md` with the two atomic scene tools:

```bash
# 1) scene project (directory product)
uvid generate scene \
  --type markdown \
  --theme <theme-from-script> \
  -i cache/NN/visual.md \
  -o cache/NN/scene \
  --duration 1

# 2) one still PNG (fast path: -f png → hyperframes snapshot, not full video render)
uvid generate render \
  -i cache/NN/scene \
  -o cache/NN/visual.png \
  -f png

# Intermediate only — not required by the checklist:
rm -rf cache/NN/scene
```

Do **not** use `-f png-sequence` or full video render for prep stills. Keep the two steps separate: `generate scene` authors the project, `generate render` turns it into media.

`cache/NN/visual.png` is a static source for later timeline work. Prep does not decide how long it appears.

## Completion checklist

For every source in `script.md`:

- [ ] `cache/NN/normalized.mp3` for `<audio>` or `cache/NN/normalized.mp4` for `<video>` exists.
- [ ] `cache/NN/asr.json` exists.
- [ ] `cache/NN/asr.srt` exists.
- [ ] `cache/NN/asr.txt` exists.

For every `<audio>` source:

- [ ] `cache/NN/visual.md` exists.
- [ ] `cache/NN/visual.png` exists.

Stop after this. Next stage is edit intent skeleton (equal-length multi-args):

```bash
uvid generate edit \
  -i cache/01/asr.json,cache/02/asr.json -o edit.json \
  --id 01,02 --type audio,video \
  --media cache/01/normalized.mp3,cache/02/normalized.mp4 \
  --visual cache/01/visual.png,-
```

Waveform, silence, frame-diff, cut decisions, timeline, and delivery are later stages. See `references/edit.md`.
