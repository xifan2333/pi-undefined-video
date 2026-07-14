# edit.json — sparse editing intent (creative file 2/3)

**One of the three authored artifacts.** The other two are `script.md` and `bgm.mml`.

`edit.json` is where cutting happens. The transcript (from ASR) is the base and
**every turn defaults to keep** — you never list what to keep. You only record the
sparse **actions** that change something (drop a turn, fix its text, hold a gap,
flag a doubt). This keeps the file small and the intent explicit.

Machine-exact contract: `schemas/edit.schema.json`. Shape at a glance:

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
      "media": "clips/01.media.mp3",    // normalized media (Step 2)
      "asr": "cache/01.asr.json",       // transcript source (Step 3)
      "visual": "clips/01.visual.png",  // audio sources only; omit for video
      "transcript": [ /* turns with stable ids, default keep */ ],
      "actions": [ /* sparse cut decisions — empty until you edit */ ]
    }
  ]
}
```

Turn/word ids are stable and assigned by the tool: `s<id>-t<NNN>` and
`s<id>-t<NNN>-w<NNN>` (e.g. `s01-t000`, `s01-t000-w000`).

## Build the skeleton — `generate edit`

**Done means:** `edit.json` holds every source in script order, each with its
`transcript` populated and `actions` empty, ready for editing.

`generate edit` reads the ASR JSON(s), assigns stable ids, and upserts sources into
`edit.json`. It **does not invent cuts** and **does not parse `script.md`** — you
pass the mapping explicitly. Re-running preserves each source's existing `actions`
and any sources you don't pass, so it is safe to re-run after adding media/ASR.

The parallel arrays `-i / --id / --type / --media` (and optional `--visual`) must be
equal length. `--type` and `--visual` follow the script tag: `<audio>` → `audio`
with a `.visual.png` still; `<video>` → `video` with `-` (no still).

```bash
# CLI
uvid generate edit \
  -i cache/01.asr.json,cache/02.asr.json,cache/03.asr.json,cache/04.asr.json,cache/05.asr.json \
  -o edit.json \
  --id 01,02,03,04,05 \
  --type audio,video,video,audio,audio \
  --media clips/01.media.mp3,clips/02.media.mp4,clips/03.media.mp4,clips/04.media.mp3,clips/05.media.mp3 \
  --visual clips/01.visual.png,-,-,clips/04.visual.png,clips/05.visual.png \
  --script script.md
```
```jsonc
// pi tool: uvid_generate_edit  (arrays, equal length; visual "-" = none)
{
  "input":  ["cache/01.asr.json", "cache/02.asr.json", "cache/03.asr.json", "cache/04.asr.json", "cache/05.asr.json"],
  "output": "edit.json",
  "id":     ["01", "02", "03", "04", "05"],
  "type":   ["audio", "video", "video", "audio", "audio"],
  "media":  ["clips/01.media.mp3", "clips/02.media.mp4", "clips/03.media.mp4", "clips/04.media.mp3", "clips/05.media.mp3"],
  "visual": ["clips/01.visual.png", "-", "-", "clips/04.visual.png", "clips/05.visual.png"],
  "script": "script.md"
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

## Editing — adding actions

> TBD — the sparse action set (drop / replace_text / hold_until / check) and how to
> apply cuts. Written after the editing pass is verified end-to-end.
