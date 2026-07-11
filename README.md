# pi-undefined-video

Pi package + CLI for episode video production: prep → draft → finish → deliver.

Install as a [pi package](https://pi.dev) (loads extensions + skills), or use the `uvid` CLI.

## Install

```bash
# npm (recommended)
pi install npm:pi-undefined-video

# project-scoped
pi install npm:pi-undefined-video -l

# GitHub
pi install git:github.com/xifan2333/pi-undefined-video

# local path (development)
pi install /path/to/pi-undefined-video
```

Also install the CLI globally if you want `uvid` on PATH:

```bash
npm install -g pi-undefined-video
```

Open a new pi session after install so tools/skills reload.

## CLI

```bash
uvid flow
uvid <stage> <action> --help
uvid prep normalize -i ep/raw/01.mp4 -o ep/clips/01.mp4 --lufs -16 --tp -1.5 --lra 11
```

The published bin runs TypeScript via `tsx` (bundled dependency).

## Package layout

```text
assets/          # avatar, sfx, themes, speaker sprite
extensions/      # pi tools (uvid_*)
schemas/         # draft.json schema
skills/          # episode workflow skill
src/             # CLI + library (spec is the single source of truth)
templates/       # HyperFrames scene templates
```

## Workflow (skill)

See `skills/undefined-video/SKILL.md`.

**AI authors three files only:** `script.md`, draft decisions in `draft.json`, and `bgm.mml`. Everything else is tools or mechanical landing.

Stages:

1. **Script** — write `script.md`
2. **Prep** — normalize loudness, external ASR
3. **Draft** — survey → init → write ranges/cuts → check
4. **Lock** — human review of voice + picture
5. **Finish** — scenes/render/dialog (tools) + write `bgm.mml` → timeline + ASS
6. **Deliver** — OTIO + optional final.mp4

Episode paths are caller policy; the skill documents a conventional `<ep>/` layout.

## Peer dependencies

Listed in `package.json` (`@earendil-works/pi-*`, `typebox`). Pi supplies these when loading the package as an extension.

## License

MIT
