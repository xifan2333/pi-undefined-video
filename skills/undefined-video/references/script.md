# Script: episode script (creative file 1/3)

**This is one of the three AI/human-authored creative files.** The other two are `edit.json` editing intent and `bgm.mml`.

**Done means:** `script.md` follows this contract, and referenced media exists under `raw/NN.ext`.

In `script.md`, media tags stay episode-relative (`raw/NN.ext`). Tool `input`/`output` elsewhere use absolute `<EPISODE>/…`. Stage docs: absolute `<SKILL_DIR>/references/…`.

## Contract

### Frontmatter

```yaml
---
theme: <theme name, e.g. onedark>
---
```

| Key | Rule |
|---|---|
| `theme` | **Required**. Theme name (e.g. onedark) for packaging / scene visuals |

### Structure

| Element | Rule |
|---|---|
| `#` | Episode title = the video's title (title source); **not** included in TOC |
| `##` | Chapter title, included in TOC |
| `###`+ | Body headings, not included in TOC |
| `---` | Separates media blocks; a block containing media is one source block |
| Media | `<audio src="raw/NN.ext">` or `<video src="raw/NN.ext">` |
| Basename `NN` | Source id |

- `<video>` means later editing must consider sound-picture relationships; it may be cut as linked audio/video or split tracks.
- `<audio>` means later editing cuts audio only; picture comes from markdown/static visuals.
- Do **not** write intro/toc/outro/bgm as media tags in the script.

### Complete example

```markdown
---
theme: onedark
---

# Example Episode

---

## Opening explanation

<audio src="raw/01.mp4"></audio>

Talking points...

---

## Screen recording demo

<video src="raw/02.mp4"></video>

---

## Closing

<audio src="raw/03.mp4"></audio>
```

## How to write it

1. Write the whole script in the contract shape in one pass: structure, media paths, and body markdown.
2. Media files must already exist, or be planned to exist, under `raw/NN.ext`.
3. Prep reads `script.md` directly according to this contract; no extra analyze-script tool is needed.

## Completion checklist

- [ ] `theme` exists (required); the episode title is the body `#` heading.
- [ ] TOC chapters use `##`.
- [ ] Every media tag points to `raw/NN.ext`.
- [ ] The TOC formed by `##` headings matches the intended episode structure.

→ Prep: `<SKILL_DIR>/references/prep.md`
