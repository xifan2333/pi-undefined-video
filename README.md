# pi-undefined-video

Pi package + CLI for episode video production: prep → draft → finish → deliver.

Install as a [pi package](https://pi.dev) (loads extensions + skills), or use the `uvid` CLI.

## Install

```bash
# local path
pi install /path/to/pi-undefined-video

# or after cloning
git clone git@github.com:xifan2333/pi-undefined-video.git
pi install ./pi-undefined-video

# project-scoped
pi install ./pi-undefined-video -l
```

Open a new pi session after install so tools/skills reload.

## CLI

Requires a runtime that can run TypeScript entrypoints (e.g. pi's node setup, or `tsx`/`node --experimental-strip-types` depending on your environment):

```bash
node src/cli.ts flow
node src/cli.ts prep normalize -i ep/raw/01.mp4 -o ep/clips/01.mp4 --lufs -16 --tp -1.5 --lra 11
```

If the package bin is linked:

```bash
uvid flow
uvid <stage> <action> --help
```

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

See `skills/undefined-video/SKILL.md`. Stages:

1. **Prep** — normalize loudness, external ASR
2. **Draft** — survey → init → decide → check
3. **Lock** — human review of voice + picture
4. **Finish** — scenes, dialog, BGM, timeline, ASS
5. **Deliver** — OTIO + optional final.mp4

Episode paths are caller policy; the skill documents a conventional `<ep>/` layout.

## Peer dependencies

Listed in `package.json` (`@earendil-works/pi-*`, `typebox`). Pi supplies these when loading the package as an extension.

## License

Private / unpublished npm package for now (`"private": true`). Source on GitHub for install via git path.
