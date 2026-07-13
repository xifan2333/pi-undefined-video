# pi-undefined-video

Pi package + `uvid` CLI: **atomic media filters** for episode video production.

Two families:

| Family | Role | Main output |
|---|---|---|
| `analyze` | evidence | one JSON (stdout or `-o`) |
| `generate` | artifact | one media/file (stdout or `-o`) |

## I/O contract

```text
-i FILE   read that file
(omit -i) read stdin          # CLI; tools should pass paths
-o FILE   write that file
(omit -o) write stdout        # CLI; JSON tools return text in result
```

Shell pipes and redirections compose filters. **No multi-file side writes** inside a command. One invocation = one input stream + one output stream. Loop outside for many files.

```bash
uvid analyze waveform -i clip.mp4 | uvid analyze silence -o silence.json
uvid analyze frame-diff -i clip.mp4 -o diff.json
uvid generate frame -i clip.mp4 --at-ms 21600 -o still.jpg
uvid generate normalize -i raw/01.mp4 -o clips/01.mp3 --lufs -16 --tp -1.5 --lra 11
# default audio format is mp3; override: -f wav | -f aac | -f mp4 (keep video)
```

## Install

```bash
pi install npm:pi-undefined-video
# or local
pi install /path/to/pi-undefined-video
npm install -g pi-undefined-video   # optional: uvid on PATH
```

Package loads extensions + skills via `package.json` `pi` key. Open a new pi session after install.

## Architecture

```text
src/spec.ts                 # command table + TypeBox (CLI + pi tools)
src/cli.ts                  # flag adapter (stderr diagnostics)
extensions/*.ts             # pi.registerTool from the same table
src/lib/io.ts               # -i/-o/stdin/stdout
src/lib/analyze/<cmd>.ts    # one module per analyze command
src/lib/generate/<cmd>.ts   # one module per generate command
src/lib/analyze|generate/index.ts  # re-export only
```

CLI and pi tools never drift: both run `CommandSpec.run` in-process.

## AI-authored files (skill)

Only three creative artifacts: `script.md`, `edit.json` (sparse cuts; `schemas/edit.schema.json`), `bgm.mml`. Everything else is filters or mechanical landing. See `skills/undefined-video/`.

## Directory-level batching

**Not defined yet** as a CLI feature. Until then: one file per invocation (`for f in …; do uvid … -i "$f" -o …; done`).

## License

MIT
