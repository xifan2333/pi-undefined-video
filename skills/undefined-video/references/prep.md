# Prep — pre-production

## Step 1 — Loudness-normalize every script media

**Done means:** every media referenced by `script.md` has a normalized product at
`clips/NN.media.<ext>`, and each product passes the loudness acceptance check.

### Do

1. Parse `script.md`; collect every `<audio|video src="raw/NN.ext">`. `NN` is the
   source id; the tag name (`audio`/`video`) selects the branch.
2. The tag is an **editing declaration, not a probe** — a raw file may carry video
   even when tagged `<audio>`. Follow the tag, not the container:
   - `<audio>` → `-f mp3`: keep normalized audio only, drop the picture (its picture
     comes later from markdown / a still).
   - `<video>` → `-f mp4`: keep the picture (video stream-copied), audio normalized.
3. Target **−16 LUFS / −1.5 dBTP / 11 LRA** for every source (one target per episode).
4. Write to `clips/NN.media.<ext>` — this is each source's `source.media`.

One invocation per file; loop outside.

```bash
# CLI
uvid generate normalize -i raw/01.mp4 -o clips/01.media.mp3        --lufs -16 --tp -1.5 --lra 11  # <audio>
uvid generate normalize -i raw/02.mp4 -o clips/02.media.mp4 -f mp4 --lufs -16 --tp -1.5 --lra 11  # <video>
```
```jsonc
// pi tool: uvid_generate_normalize
{ "input": "raw/01.mp4", "output": "clips/01.media.mp3",                     "lufs": -16, "tp": -1.5, "lra": 11 }  // <audio>
{ "input": "raw/02.mp4", "output": "clips/02.media.mp4", "format": "mp4", "lufs": -16, "tp": -1.5, "lra": 11 }  // <video>
```

### Accept — verify loudness

For each product, read the measurement from stdout (no file needed):

```bash
# CLI（reads stdout）
uvid analyze loudness -i clips/NN.media.<ext>
```
```jsonc
// pi tool: uvid_analyze_loudness（no output → JSON in the tool result）
{ "input": "clips/NN.media.<ext>" }
```

Pass when **`|I − (−16)| ≤ 1.0`** and **`peak ≤ −1.5`**.

- `1 LU ≈ 1 dB`; a difference below ~1 LU is imperceptible, so ±1.0 keeps every
  source at the same apparent loudness (EBU R128 convention). ~3 dB is where a
  listener clearly hears "louder / quieter".
- `peak` here is sample peak (dBFS), which is ≤ the true-peak (dBTP) target — a
  conservative clipping check, sufficient in practice.

### Checklist

- [ ] Every `script.md` media has a `clips/NN.media.<ext>`.
- [ ] `<audio>` → mp3 (audio only); `<video>` → mp4 (picture kept).
- [ ] Each product: `|I + 16| ≤ 1.0` and `peak ≤ −1.5`.
