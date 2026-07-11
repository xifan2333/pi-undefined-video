/**
 * Scene commands: create renderable HyperFrames scene/project directories from
 * package templates, and render the 4 RPG dialog state PNGs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Ctx, copyFileChecked, ensureDir, escapeHtml, fail, rel, resolvePath } from "./util.ts";
import { exec } from "./proc.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ASSETS_DIR = path.join(PKG_ROOT, "assets");
const TEMPLATES_DIR = path.join(PKG_ROOT, "templates");

function resetSceneDir(outDir: string): void {
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(path.join(outDir, "assets"));
}

function copyThemeAssets(outDir: string): void {
  copyFileChecked(path.join(ASSETS_DIR, "themes.css"), path.join(outDir, "assets", "themes.css"));
}

function patchTheme(html: string, theme: string): string {
  return html.replace(/data-theme="[^"]+"/, `data-theme="${theme}"`);
}

function stripAudioTags(html: string): string {
  // Scenes are visual-only. Audio belongs to explicit timeline/audio tracks.
  return html.replace(/\n\s*<audio\b[\s\S]*?<\/audio>\s*/g, "\n");
}

function watermarkHtml(text: string | null | undefined): string {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const inner = escaped.startsWith("@") ? `<span class="at">@</span>${escaped.slice(1)}` : escaped;
  return `<div class="watermark">${inner}</div>`;
}

function createDialogScene(outDir: string, theme: string, speakerSprite: string, fps: number, ctx: Ctx): void {
  resetSceneDir(outDir);
  copyThemeAssets(outDir);
  copyFileChecked(path.join(ASSETS_DIR, "components.css"), path.join(outDir, "assets", "components.css"));
  const spritePath = resolvePath(ctx, speakerSprite);
  if (!fs.existsSync(spritePath)) fail(`speaker sprite data does not exist: ${speakerSprite}`);
  copyFileChecked(spritePath, path.join(outDir, "assets", "speaker-sprite-data.js"));
  const duration = 4 / fps;
  const template = patchTheme(fs.readFileSync(path.join(TEMPLATES_DIR, "dialog.html"), "utf8"), theme)
    .replace(/data-duration="[^"]+"/, `data-duration="${duration}"`)
    .replace(/data-fps="[^"]+"/, `data-fps="${fps}"`)
    .replace(/tl\.to\(\{\}, \{duration:[^}]+\}, 0\);/, `tl.to({}, {duration:${duration}}, 0);`);
  fs.writeFileSync(path.join(outDir, "index.html"), template);
}

function createIntroScene(outDir: string, theme: string): void {
  resetSceneDir(outDir);
  copyThemeAssets(outDir);
  const template = stripAudioTags(patchTheme(fs.readFileSync(path.join(TEMPLATES_DIR, "intro.html"), "utf8"), theme));
  fs.writeFileSync(path.join(outDir, "index.html"), template);
}

function createOutroScene(outDir: string, theme: string, avatar: string, ctx: Ctx): void {
  resetSceneDir(outDir);
  copyThemeAssets(outDir);
  const avatarPath = resolvePath(ctx, avatar);
  if (!fs.existsSync(avatarPath)) fail(`avatar does not exist: ${avatar}`);
  copyFileChecked(avatarPath, path.join(outDir, "assets", "avatar.png"));
  const template = stripAudioTags(patchTheme(fs.readFileSync(path.join(TEMPLATES_DIR, "outro.html"), "utf8"), theme))
    .replace(/src="assets\/avator\.png"/g, 'src="assets/avatar.png"');
  fs.writeFileSync(path.join(outDir, "index.html"), template);
}

function readChapters(p: SceneCreateParams, ctx: Ctx): string[] {
  if (p.chaptersFile && p.chaptersJson) fail("use only one of --chapters-file or --chapters-json");
  if (!p.chaptersFile && !p.chaptersJson) fail("missing required --chapters-file or --chapters-json");
  const raw = p.chaptersFile ? fs.readFileSync(resolvePath(ctx, p.chaptersFile), "utf8") : p.chaptersJson!;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((x: any) => typeof x === "string")) {
    fail("chapters must be a JSON array of strings");
  }
  return parsed;
}

function createTocScene(outDir: string, p: SceneCreateParams, ctx: Ctx): void {
  const theme = p.theme || fail("missing required --theme");
  const id = p.id || fail("missing required --id");
  if (p.duration == null) fail("missing required --duration");
  if (p.currentIndex == null) fail("missing required --current-index");
  if (p.previousIndex == null) fail("missing required --previous-index");
  const chapters = readChapters(p, ctx);
  if (p.currentIndex < 0 || p.currentIndex >= chapters.length) fail(`--current-index out of range: ${p.currentIndex}`);
  if (p.previousIndex < 0 || p.previousIndex >= chapters.length) fail(`--previous-index out of range: ${p.previousIndex}`);

  resetSceneDir(outDir);
  copyThemeAssets(outDir);
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, "toc.html"), "utf8")
    .replaceAll("__THEME__", theme)
    .replaceAll("__COMP_ID__", id)
    .replaceAll("__DURATION__", String(p.duration))
    .replaceAll("__CHAPTERS_JSON__", JSON.stringify(chapters))
    .replaceAll("__CURRENT__", String(p.currentIndex))
    .replaceAll("__PREVIOUS__", String(p.previousIndex))
    .replace(/<div class="watermark">[\s\S]*?<\/div>\s*<\/div>\s*\n\s*<script/, `${watermarkHtml(p.watermark)}\n    </div>\n\n    <script`);
  fs.writeFileSync(path.join(outDir, "index.html"), template);
}

function readTextInput(p: SceneCreateParams, ctx: Ctx): string {
  if (!p.input) fail("missing required -i/--input");
  if (p.input === "-") return fs.readFileSync(0, "utf8");
  const input = resolvePath(ctx, p.input);
  if (!fs.existsSync(input)) fail(`input does not exist: ${p.input}`);
  return fs.readFileSync(input, "utf8");
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
      { scope: ["keyword", "storage", "entity.name.tag"], settings: { foreground: "var(--shiki-token-keyword)" } },
      { scope: ["entity.name.function", "support.function"], settings: { foreground: "var(--shiki-token-function)" } },
      { scope: ["constant.numeric"], settings: { foreground: "var(--shiki-token-number)" } },
      { scope: ["constant.language", "variable.language"], settings: { foreground: "var(--shiki-token-constant)" } },
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
    return highlighted.get(idx) || (defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options));
  };
  return md.renderer.render(tokens, md.options, {});
}

async function createMarkdownScene(outDir: string, p: SceneCreateParams, ctx: Ctx): Promise<void> {
  const theme = p.theme || fail("missing required --theme");
  const duration = p.duration ?? 4;
  const markdown = readTextInput(p, ctx);
  const bodyHtml = await renderMarkdownHtml(markdown);

  resetSceneDir(outDir);
  copyThemeAssets(outDir);
  copyFileChecked(path.join(ASSETS_DIR, "components.css"), path.join(outDir, "assets", "components.css"));

  const html = fs.readFileSync(path.join(TEMPLATES_DIR, "markdown.html"), "utf8")
    .replaceAll("{{theme}}", escapeHtml(theme))
    .replaceAll("{{duration}}", escapeHtml(String(duration)))
    .replaceAll("{{bodyHtml}}", bodyHtml)
    .replaceAll("{{watermarkHtml}}", watermarkHtml(p.watermark));
  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

export interface SceneCreateParams {
  type: string;
  output: string;
  theme?: string;
  input?: string;
  avatar?: string;
  speakerSprite?: string;
  fps?: number;
  watermark?: string;
  id?: string;
  duration?: number;
  chaptersJson?: string;
  chaptersFile?: string;
  currentIndex?: number;
  previousIndex?: number;
}

/** Create a renderable HyperFrames scene/project directory of the given type. */
export async function sceneCreate(p: SceneCreateParams, ctx: Ctx): Promise<void> {
  const outDir = resolvePath(ctx, p.output);

  if (p.type === "dialog") {
    createDialogScene(outDir, p.theme || fail("missing required --theme"), p.speakerSprite || fail("missing required --speaker-sprite"), p.fps ?? 25, ctx);
  } else if (p.type === "markdown") {
    await createMarkdownScene(outDir, p, ctx);
  } else if (p.type === "intro") {
    createIntroScene(outDir, p.theme || fail("missing required --theme"));
  } else if (p.type === "outro") {
    createOutroScene(outDir, p.theme || fail("missing required --theme"), p.avatar || fail("missing required --avatar"), ctx);
  } else if (p.type === "toc") {
    createTocScene(outDir, p, ctx);
  } else {
    fail(`unsupported scene type: ${p.type}`);
  }

  ctx.log(`uvid finish scene: wrote ${p.type} scene to ${rel(ctx, outDir)}`);
}

export interface ImageDialogParams {
  output: string;
  theme: string;
  speakerSprite: string;
  fps?: number;
}

/** Render the four RPG dialog-box state PNGs via a 1-second HyperFrames render. */
export async function imageCreateDialog(p: ImageDialogParams, ctx: Ctx): Promise<void> {
  const outDir = resolvePath(ctx, p.output);
  const fps = p.fps ?? 25;

  const projectDir = path.join(outDir, "rpg-states");
  const framesDir = path.join(projectDir, "frames");
  createDialogScene(projectDir, p.theme, p.speakerSprite, fps, ctx);

  ctx.log("uvid finish dialog: rendering RPG state frames (hyperframes)");
  // Requires globally installed hyperframes (see skill prerequisites).
  await exec("hyperframes", [
    "render", projectDir,
    "--format", "png-sequence",
    "--output", framesDir,
    "--fps", String(fps),
    "--quality", "high",
    "--workers", "1",
  ], { signal: ctx.signal, timeoutMs: 10 * 60 * 1000 });

  const mapping: Array<[string, string]> = [
    ["frame_000001.png", "rpg-open-arrow.png"],
    ["frame_000002.png", "rpg-closed-arrow.png"],
    ["frame_000003.png", "rpg-open-noarrow.png"],
    ["frame_000004.png", "rpg-closed-noarrow.png"],
  ];
  for (const [srcName, dstName] of mapping) {
    copyFileChecked(path.join(framesDir, srcName), path.join(outDir, dstName));
  }

  ctx.log(`uvid finish dialog: wrote 4 RPG state PNGs to ${rel(ctx, outDir)}`);
  for (const [, dstName] of mapping) ctx.log(`  ${dstName}`);
}
