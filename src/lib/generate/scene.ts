/**
 * uvid generate scene — one HyperFrames scene project directory.
 *
 * Templates live as folders (HyperFrames-shaped):
 *   templates/<type>/{index.html, assets/...}
 * Shared theme: templates/_shared/themes.css
 *
 * generate scene = copy package template → patch vars → emit scene dir.
 * Stock types only: intro | outro | toc | markdown | dialog.
 * Freeform AI HTML is NOT a scene type — author a HyperFrames project dir
 * and call `uvid generate render` on it directly.
 * Independent of edit.json. Multi-scene = multiple invocations.
 */
import fs from "node:fs";
import path from "node:path";
import { emitWrittenPath } from "../io.ts";
import {
  type Ctx,
  copyFileChecked,
  ensureDir,
  escapeHtml,
  fail,
  packageRoot,
  rel,
  resolvePath,
} from "../util.ts";

const PKG = packageRoot();
const TEMPLATES_DIR = path.join(PKG, "templates");
const SHARED_DIR = path.join(TEMPLATES_DIR, "_shared");

export type SceneType = "intro" | "outro" | "toc" | "markdown" | "dialog";

export interface GenerateSceneParams {
  /** Scene type: intro | outro | toc | markdown | dialog */
  type: string;
  /** Output scene project directory (required). */
  output: string;
  theme?: string;
  /** Markdown source for type=markdown (-i / stdin). */
  input?: string;
  /** Speaker sprite JSON path; type=dialog default: template assets/speaker-sprite.json */
  speakerSprite?: string;
  fps?: number;
  watermark?: string;
  /** Composition id; toc defaults to basename(-o). */
  id?: string;
  /** Seconds for type=markdown only (default 4). TOC/intro/outro length is owned by the template. */
  duration?: number;
  /** Comma-separated chapter titles for type=toc (primary). */
  chapters?: string;
  /** Optional JSON array file of chapter titles; exclusive with --chapters. */
  chaptersFile?: string;
  /** 0-based current chapter index for type=toc. */
  current?: number;
  /**
   * 0-based previous chapter index for cursor travel (toc).
   * Default: current > 0 ? current - 1 : current.
   */
  previous?: number;
}

function templateDir(type: SceneType): string {
  const dir = path.join(TEMPLATES_DIR, type);
  if (!fs.existsSync(path.join(dir, "index.html"))) {
    fail(`template missing: templates/${type}/index.html`);
  }
  return dir;
}

/** Copy a template folder into outDir (index.html + assets/*), then overlay shared theme. */
function materializeTemplate(type: SceneType, outDir: string): void {
  const src = templateDir(type);
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);
  fs.cpSync(src, outDir, { recursive: true });
  // Shared theme always wins so one palette source stays authoritative.
  ensureDir(path.join(outDir, "assets"));
  const themeCss = path.join(SHARED_DIR, "themes.css");
  if (!fs.existsSync(themeCss)) fail("templates/_shared/themes.css missing");
  copyFileChecked(themeCss, path.join(outDir, "assets", "themes.css"));
}

function readIndex(outDir: string): string {
  return fs.readFileSync(path.join(outDir, "index.html"), "utf8");
}

function writeIndex(outDir: string, html: string): void {
  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

function watermarkHtml(text: string | null | undefined): string {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const inner = escaped.startsWith("@") ? `<span class="at">@</span>${escaped.slice(1)}` : escaped;
  return `<div class="watermark">${inner}</div>`;
}

function loadSpeakerSpriteJson(rawPath: string | undefined, outDir: string, ctx: Ctx): string {
  const defaultPath = path.join(outDir, "assets", "speaker-sprite.json");
  const abs = rawPath ? resolvePath(ctx, rawPath) : defaultPath;
  if (!fs.existsSync(abs)) {
    fail(
      rawPath
        ? `speaker sprite does not exist: ${rawPath}`
        : "dialog template missing assets/speaker-sprite.json",
    );
  }
  if (path.extname(abs).toLowerCase() !== ".json") {
    fail(`speaker sprite must be a .json file: ${rawPath || abs}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (error: any) {
    fail(`invalid speaker sprite JSON: ${error?.message || error}`);
  }
  if (!data || typeof data !== "object") fail("speaker sprite must be a JSON object");
  const obj = data as Record<string, unknown>;
  for (const key of ["w", "h", "mouth", "palette", "base", "mouthOpened", "mouthClosed"]) {
    if (!(key in obj)) fail(`speaker sprite missing key: ${key}`);
  }

  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(outDir, "assets", "speaker-sprite.json"), json);
  return json;
}

function createDialogScene(
  outDir: string,
  theme: string,
  speakerSprite: string | undefined,
  fps: number,
  ctx: Ctx,
): void {
  materializeTemplate("dialog", outDir);
  const spriteJson = loadSpeakerSpriteJson(speakerSprite, outDir, ctx);
  // Static 4-state chrome: one still per data-state; no loop duration.
  const html = readIndex(outDir)
    .replaceAll("{{theme}}", escapeHtml(theme))
    .replaceAll("{{fps}}", escapeHtml(String(fps)))
    .replaceAll("{{speakerSpriteJson}}", spriteJson);
  if (html.includes("{{theme}}") || html.includes("{{fps}}") || html.includes("{{speakerSpriteJson}}")) {
    fail("dialog template missing {{theme}} / {{fps}} / {{speakerSpriteJson}} placeholder");
  }
  writeIndex(outDir, html);
}

function createIntroScene(outDir: string, theme: string): void {
  materializeTemplate("intro", outDir);
  writeIndex(outDir, readIndex(outDir).replaceAll("{{theme}}", escapeHtml(theme)));
}

function createOutroScene(outDir: string, theme: string): void {
  materializeTemplate("outro", outDir);
  writeIndex(outDir, readIndex(outDir).replaceAll("{{theme}}", escapeHtml(theme)));
}

function readChapters(p: GenerateSceneParams, ctx: Ctx): string[] {
  if (p.chapters && p.chaptersFile) fail("use only one of --chapters or --chapters-file");
  if (!p.chapters && !p.chaptersFile) fail("type=toc needs --chapters 'a,b,c' (or --chapters-file)");

  if (p.chaptersFile) {
    const raw = fs.readFileSync(resolvePath(ctx, p.chaptersFile), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: any) {
      fail(`invalid chapters file JSON: ${error?.message || error}`);
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      fail("--chapters-file must be a JSON array of strings");
    }
    const list = (parsed as string[]).map((s) => s.trim()).filter(Boolean);
    if (!list.length) fail("--chapters-file is empty");
    return list;
  }

  const list = String(p.chapters!)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) fail("--chapters is empty");
  return list;
}

function createTocScene(outDir: string, p: GenerateSceneParams, ctx: Ctx): void {
  const theme = p.theme || fail("missing required --theme");
  const chapters = readChapters(p, ctx);
  if (p.current == null) fail("type=toc needs --current N (0-based)");
  const current = p.current;
  if (!Number.isInteger(current) || current < 0 || current >= chapters.length) {
    fail(`--current out of range: ${current} (chapters=${chapters.length})`);
  }
  const previous = p.previous ?? (current > 0 ? current - 1 : current);
  if (!Number.isInteger(previous) || previous < 0 || previous >= chapters.length) {
    fail(`--previous out of range: ${previous} (chapters=${chapters.length})`);
  }
  if (p.duration != null) {
    fail("type=toc does not take --duration; length is owned by templates/toc/");
  }
  const id = (p.id?.trim() || path.basename(outDir) || "toc").replace(/[^\w.-]+/g, "-");

  materializeTemplate("toc", outDir);
  let html = readIndex(outDir)
    .replaceAll("{{theme}}", escapeHtml(theme))
    .replaceAll("{{compId}}", escapeHtml(id))
    .replaceAll("{{chaptersJson}}", JSON.stringify(chapters))
    .replaceAll("{{current}}", String(current))
    .replaceAll("{{previous}}", String(previous));
  // Replace only the watermark node; keep composition-owned <audio sfx>.
  if (p.watermark != null) {
    html = html.replace(/<div class="watermark">[\s\S]*?<\/div>/, watermarkHtml(p.watermark) || "");
  }
  writeIndex(outDir, html);
}

async function readMarkdownInput(p: GenerateSceneParams, ctx: Ctx): Promise<string> {
  if (p.input) {
    const abs = resolvePath(ctx, p.input);
    if (!fs.existsSync(abs)) fail(`input does not exist: ${p.input}`);
    return fs.readFileSync(abs, "utf8");
  }
  if (ctx.toolHost) fail("type=markdown needs -i FILE (no stdin in tool host)");
  if (process.stdin.isTTY) fail("type=markdown needs -i FILE or markdown on stdin");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function renderMarkdownHtml(markdown: string): Promise<string> {
  const MarkdownIt = (await import("markdown-it")).default;
  const { codeToHtml } = await import("shiki");
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  const shikiTheme = {
    name: "uvid-css-vars",
    type: "dark",
    colors: {
      "editor.foreground": "var(--shiki-foreground)",
      "editor.background": "transparent",
    },
    tokenColors: [
      { scope: ["comment"], settings: { foreground: "var(--shiki-token-comment)" } },
      { scope: ["string"], settings: { foreground: "var(--shiki-token-string)" } },
      {
        scope: ["keyword", "storage", "entity.name.tag"],
        settings: { foreground: "var(--shiki-token-keyword)" },
      },
      {
        scope: ["entity.name.function", "support.function"],
        settings: { foreground: "var(--shiki-token-function)" },
      },
      { scope: ["constant.numeric"], settings: { foreground: "var(--shiki-token-number)" } },
      {
        scope: ["constant.language", "variable.language"],
        settings: { foreground: "var(--shiki-token-constant)" },
      },
      { scope: ["variable.parameter"], settings: { foreground: "var(--shiki-token-parameter)" } },
      { scope: ["punctuation"], settings: { foreground: "var(--shiki-token-punctuation)" } },
    ],
  };

  const tokens = md.parse(markdown, {});
  const highlighted = new Map<number, string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "fence") continue;
    const lang = String(token.info || "text").trim().split(/\s+/)[0] || "text";
    try {
      highlighted.set(i, await codeToHtml(token.content, { lang, theme: shikiTheme as any }));
    } catch {
      highlighted.set(i, await codeToHtml(token.content, { lang: "text", theme: shikiTheme as any }));
    }
  }

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens: any[], idx: number, options: any, env: any, self: any) => {
    return (
      highlighted.get(idx) ||
      (defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options))
    );
  };
  return md.renderer.render(tokens, md.options, {});
}

async function createMarkdownScene(
  outDir: string,
  p: GenerateSceneParams,
  ctx: Ctx,
): Promise<void> {
  const theme = p.theme || fail("missing required --theme");
  const duration = p.duration ?? 4;
  const markdown = await readMarkdownInput(p, ctx);
  const bodyHtml = await renderMarkdownHtml(markdown);

  materializeTemplate("markdown", outDir);
  const html = readIndex(outDir)
    .replaceAll("{{theme}}", escapeHtml(theme))
    .replaceAll("{{duration}}", escapeHtml(String(duration)))
    .replaceAll("{{bodyHtml}}", bodyHtml)
    .replaceAll("{{watermarkHtml}}", watermarkHtml(p.watermark));
  writeIndex(outDir, html);
}

export async function generateScene(p: GenerateSceneParams, ctx: Ctx): Promise<void> {
  if (!p.output) fail("generate scene requires -o DIR (scene project directory)");
  const outDir = resolvePath(ctx, p.output);
  const type = (p.type || "").trim() as SceneType;

  if (type === "dialog") {
    createDialogScene(
      outDir,
      p.theme || fail("missing required --theme"),
      p.speakerSprite,
      p.fps ?? 25,
      ctx,
    );
  } else if (type === "markdown") {
    await createMarkdownScene(outDir, p, ctx);
  } else if (type === "intro") {
    createIntroScene(outDir, p.theme || fail("missing required --theme"));
  } else if (type === "outro") {
    createOutroScene(outDir, p.theme || fail("missing required --theme"));
  } else if (type === "toc") {
    createTocScene(outDir, p, ctx);
  } else {
    fail(
      `unsupported scene type: ${p.type || "(empty)"} (intro|outro|toc|markdown|dialog). ` +
        `Freeform HyperFrames HTML: write a scene dir with index.html and run ` +
        `uvid generate render -i that-dir (no generate scene).`,
    );
  }

  if (!fs.existsSync(path.join(outDir, "index.html"))) {
    fail(`scene incomplete: missing index.html under ${outDir}`);
  }
  ctx.log(`generate scene type=${type} → ${rel(ctx, outDir)}`);
  emitWrittenPath(ctx, outDir);
}
