# Cover — B 站封面

**Done means:** episode-root `cover.png` is upload-ready: B 站 size, theme palette, episode title, and a look the human asked for.

**Who decides what**

| Layer | Owner | Source |
|---|---|---|
| Spec (size / safe area / title / palette roles) | skill + tool | this file + `assets/themes.css` |
| Theme name | human (script) | `script.md` frontmatter `theme:` |
| Title text | human (script) | body `#` heading — verbatim |
| **Style + picture content** | **human** | chat brief this turn (not invented by the agent) |

The agent **does not** invent cover concept, motif, or art style. If the human only says “做封面” / “生成本期封面” without style and content, **ask first**, then generate.

## B 站规格（硬约束）

| Item | Value |
|---|---|
| Final size | **1146×717** |
| Aspect | Landscape |
| Format | PNG preferred |
| Safe area | Title + main subject in **center ~80%** (edges crop on cards/mobile) |
| Title | 1 main line from script `#`; large; thumbnail-legible |
| Text budget | Main title only unless human asks for a badge/subtitle |
| Avoid | Watermarks, tiny body copy, edge-hugging text, low-contrast title |

Generate larger if useful (e.g. 1536×1024), then crop:

```bash
magick input.png -resize 1146x717^ -gravity center -extent 1146x717 cover.png
```

## Theme palette（硬约束）

Colors come only from `assets/themes.css` → `[data-theme="<theme>"]`. Put **hex** in the prompt, not CSS var names. Do not invent a second brand palette.

| Token | Cover role |
|---|---|
| `--bg` | canvas |
| `--fg` | title |
| `--muted` | dim chrome |
| `--link` / `--keyword` | accents |
| `--ok` / `--warn` / `--danger` / `--magenta` | sparse highlights only |

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

**Palette is a hard lock, not a vibe.** Models drift (pure black canvas, pure white title). In the prompt: state exact hex, forbid pure black/white when the theme is not those colors, and re-check after render. Prefer regenerate with a tighter brief over heavy remaps.

## Title type (soft reference — do not over-lock)

Episode UI fonts from `assets/themes.css` (same as intro/toc/dialog):

| Role | Font |
|---|---|
| Display / titles | `Uranus Pixel 11Px` |
| Body / mono | `Fusion Pixel 12px M zh_hans` |
| Caption | `BoutiqueBitmap7x7 1.7` |

These are a **taste reference**, not a hard prompt lock.

- Prefer title lettering that **fits the human style** (pixel game → chunky game-title CJK; flat poster → bold poster type; etc.).
- Do **not** paste long font-engineering text into the image prompt (no “exact Uranus Pixel path / 8-bit stroke grid / no anti-alias” essays). That over-constrains the model and often yields ugly pseudo-黑体.
- One short line is enough, e.g. `title lettering: bold chunky pixel game-title CJK, same energy as Uranus Pixel` — or omit if style already implies it.
- Hard locks stay: **verbatim title string**, **theme hex**, **safe area**, **thumbnail legible**.

## Human brief（创意层 — 必须有）

Before calling the image tool, collect (or wait for) a short brief:

1. **Style** — e.g. pixel UI / flat illustration / 3D clay / photo collage / hand-drawn…
2. **Content** — what is on screen: objects, scene, motif, mood (topic-related or abstract)
3. Optional: layout notes (title top/center, left motif, badge, etc.)

Examples of enough brief:

- “像素风，终端文件列表，标题居中，onedark”
- “扁平插画，一只企鹅在敲键盘，标题在下三分之一”
- “只有大标题 + 抽象波形，极简，东京夜色”

Not enough → ask:

- “做封面” / “生成本期封面” with no style or content

Agent fills only the **spec shell** (size, safe area, theme hex, title string, tool flags). Style + content lines come from the human wording, lightly cleaned — not replaced with a default “terminal UI” concept.

## Tool — `codex_generate_image`

Package `pi-codex-image-gen`. Auth: existing **openai-codex** login (`/login` → ChatGPT Plus/Pro). No `OPENAI_API_KEY`. Backend image model: **gpt-image-2**.

| Param | Required | Notes |
|---|---|---|
| `prompt` | yes | Spec shell + human style/content + exact title; **size is in the prompt** |
| `outputFormat` | no | `png` default |
| `save` | no | use `custom` for episode deliverable |
| `saveDir` | when custom | episode dir; then crop → `cover.png` |
| `model` | no | Codex routing model only |

### Workflow

1. Read `script.md` → `theme` + `#` title.
2. If style/content missing → **ask**; stop.
3. Resolve hex from table / `assets/themes.css`.
4. Assemble prompt = **spec shell** + **human style** + **human content** + title + palette lock.
5. `codex_generate_image` → save under episode dir.
6. Crop to `cover.png` (1146×717).
7. Show human; iterate only on their feedback (one change at a time).

### Prompt assembly

Keep the prompt short. Spec shell + human style/content + title + palette. Optional one-line type mood — no font name laundry list.

```text
Asset type: Bilibili cover, landscape ~1536x1024, final crop 1146x717
Safe area: main title and subject in center 80%; margins from edges
Theme palette lock (<theme> hex only):
  bg <bg>, title <fg>, accents <link>/<ok>, muted <muted>
  Do not use pure black or pure white unless those hexes are in the theme
Text (verbatim, only required readable line): "<# title from script>"
Style (from human): <…>
Content (from human): <…>
Title type (optional one line): <mood matching style, e.g. chunky pixel game title>
Constraints: thumbnail-legible title; no watermark; no extra slogans unless human asked
```

Do **not** prepend a stock “pixel terminal / file manager” concept unless the human asked for it.
Do **not** over-specify font engineering in the prompt.

### Call shape

```jsonc
// codex_generate_image
{
  "prompt": "<assembled>",
  "outputFormat": "png",
  "save": "custom",
  "saveDir": "<episode>"
}
```

Final deliverable path: `<episode>/cover.png`. Do not leave the only copy under `~/.pi/agent/generated-images/`.

## Checklist

- [ ] Human gave style + content (or confirmed defaults they chose).
- [ ] Theme + title from `script.md`; hex from `assets/themes.css`.
- [ ] `cover.png` is 1146×717; title in safe area; thumbnail-legible.
- [ ] Human accepted the look (or requested a targeted revision).
