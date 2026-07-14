# Cover — B 站封面

**Done means:** episode-root `cover.png` matches `script.md` theme palette, shows the episode title, and is ready for B 站 upload.

Source of truth for colors: `assets/themes.css` (same tokens as scenes). Frontmatter `theme:` selects the block.

## B 站规格

| Item | Value |
|---|---|
| Upload size | **1146×717** (community standard; ≈16:10) |
| Aspect | Landscape only |
| Format | PNG or JPG; keep under platform size limits |
| Safe area | Keep title/subject in the **center ~80%** — corners/edges crop in cards & mobile |
| Title | Large, high-contrast, readable at **thumbnail** size (feed ~1/4–1/6 screen) |
| Text budget | 1 main title (≤ ~12 Chinese chars preferred); optional 1 short badge/subtitle |
| Avoid | Watermark noise, tiny body copy, low-contrast fg/bg, edge-hugging text |

Generate larger if the model needs it (e.g. 1536×1024 or 1920×1080), then downscale:

```bash
magick input.png -resize 1146x717^ -gravity center -extent 1146x717 cover.png
# or
ffmpeg -y -i input.png -vf "scale=1146:717:force_original_aspect_ratio=increase,crop=1146:717" cover.png
```

## Theme palette

Read `assets/themes.css` → `[data-theme="<theme>"]`. Use these semantic roles in the prompt (hex, not CSS var names):

| Token | Role on cover |
|---|---|
| `--bg` | canvas / deep fill |
| `--fg` | primary title |
| `--muted` | secondary labels, dim chrome |
| `--link` / `--keyword` | accent shapes, terminal glow, code highlights |
| `--ok` / `--warn` / `--danger` / `--magenta` | sparingly — badges, hot spots (not all at once) |

Default fonts in CSS are pixel (`Uranus Pixel` / `Fusion Pixel`) — prefer a **pixel / terminal / retro-UI** cover language so it matches intro/toc/dialog. Do not invent a second brand palette.

Quick table (bg / fg / link / ok / warn / magenta):

| theme | bg | fg | link | ok | warn | magenta |
|---|---|---|---|---|---|---|
| onedark | `#282c34` | `#abb2bf` | `#61afef` | `#98c379` | `#e5c07b` | `#c678dd` |
| everforest | `#272e33` | `#d3c6aa` | `#7fbbb3` | `#a7c080` | `#dbbc7f` | `#d699b6` |
| tokyo-night | `#1a1b26` | `#c0caf5` | `#7aa2f7` | `#9ece6a` | `#e0af68` | `#bb9af7` |
| catppuccin | `#1e1e2e` | `#cdd6f4` | `#87b0f9` | `#a6e3a1` | `#f9e2af` | `#f5c2e7` |
| nord | `#2e3440` | `#d8dee9` | `#81a1c1` | `#a3be8c` | `#ebcb8b` | `#b48ead` |
| gruvbox | `#282828` | `#ebdbb2` | `#458588` | `#98971a` | `#d79921` | `#b16286` |
| kanagawa | `#1f1f28` | `#dcd7ba` | `#7e9cd8` | `#76946a` | `#c0a36e` | `#957fb8` |
| matte-black | `#121212` | `#bebebe` | `#e68e0d` | `#ffc107` | `#b91c1c` | `#d35f5f` |
| onelight | `#fafafa` | `#383a42` | `#4078f2` | `#50a14f` | `#c18401` | `#a626a4` |
| rose-pine | `#faf4ed` | `#575279` | `#56949f` | `#286983` | `#ea9d34` | `#907aa9` |
| ristretto | `#2c2525` | `#e6d9db` | `#f38d70` | `#adda78` | `#f9cc6c` | `#a8a9eb` |
| osaka-jade | `#111c18` | `#c1c497` | `#509475` | `#549e6a` | `#459451` | `#d2689c` |
| catppuccin-latte | `#eff1f5` | `#4c4f69` | `#1e66f5` | `#40a02b` | `#df8e1d` | `#ea76cb` |

Full token set (incl. shiki / ANSI color0–15) lives only in `assets/themes.css` — open it when you need more than the table.

## Generate with Codex image plugin

Package: `pi-codex-image-gen` (tool name **`codex_generate_image`**). Uses existing **openai-codex** login — no `OPENAI_API_KEY`. Image model is always **gpt-image-2** on the backend.

Requires login once:

```text
/login  →  ChatGPT Plus/Pro (Codex)
```

### Tool params

| Param | Required | Notes |
|---|---|---|
| `prompt` | yes | Full visual + text spec (size lives **in the prompt** — no size flag) |
| `outputFormat` | no | `png` (default) / `jpeg` / `webp` |
| `save` | no | `none` \| `project` \| `global` \| `custom` |
| `saveDir` | when `save=custom` | Relative → workspace; use episode dir for deliverables |
| `model` | no | Codex **routing** model only (default `gpt-5.5`); not the image model |

Default save lands under `~/.pi/agent/generated-images/…`. For the episode deliverable always `save: "custom"` + `saveDir` pointing at the episode (or generate then `cp` → `cover.png`).

### Workflow

1. Read `script.md`: `theme` + body `#` title (+ optional one-line topic).
2. Resolve palette from the table / `assets/themes.css`.
3. Build a structured prompt (below); put **exact title text** in quotes.
4. Call `codex_generate_image` with `outputFormat: "png"`, `save: "custom"`, `saveDir: "<episode>"` (or save then move).
5. Downscale/crop to **1146×717** → final `cover.png` at episode root.
6. Inspect: title legible small, theme colors correct, no edge crop risk. Iterate with one targeted change.

### Prompt skeleton

```text
Use case: ads-marketing
Asset type: Bilibili video cover / thumbnail, landscape 1536x1024 then crop to 1146x717
Primary request: pixel-art / terminal-UI style cover for a tech tutorial episode
Subject: subtle terminal or code-adjacent motif matching the topic (<topic>)
Style/medium: retro pixel UI, clean flat shapes, no photoreal noise
Composition/framing: title large and centered in the safe 80% area; leave margin from edges
Color palette (exact hex only — match episode theme <theme>):
  background <bg>, title <fg>, accents <link> / <ok>, muted chrome <muted>
Text (verbatim): "<episode title from script # heading>"
Typography: bold pixel / bitmap font feel; high contrast on bg; Chinese + Latin spacing if mixed
Constraints: single clear title; readable at small thumbnail size; no watermark; no extra slogans; no photoreal faces; no cluttered paragraphs
Avoid: colors outside the palette; tiny text; edge-hugging title; stock photo look
```

Example for `theme: onedark`, title `未定义项目工作流测试`:

```text
… Color palette: background #282c34, title #abb2bf, accents #61afef / #98c379, muted #5c6370
Text (verbatim): "未定义项目工作流测试"
```

### Call shape (agent)

```jsonc
// codex_generate_image
{
  "prompt": "<filled skeleton>",
  "outputFormat": "png",
  "save": "custom",
  "saveDir": "20260709"   // episode dir under workspace
}
```

Then resize to `cover.png` as above. Do not leave the only copy under `~/.pi/agent/generated-images/`.

## Checklist

- [ ] Theme from `script.md` frontmatter; hex from `assets/themes.css` / table.
- [ ] Title text matches body `#` exactly (including CJK–Latin spaces if any).
- [ ] Final file `cover.png` is **1146×717**, title in center safe area.
- [ ] Thumbnail-legible; palette matches intro/toc/dialog feel.
