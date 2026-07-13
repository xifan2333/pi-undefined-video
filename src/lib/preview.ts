/**
 * uvid preview — open media in a viewer. No file product.
 *
 *   video / audio → mpv
 *   image        → imv
 *
 * Contact sheets are a separate filter: `uvid generate sheet … -o sheet.jpg`
 * then `uvid preview sheet.jpg`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  collectPaths,
  requireBin,
  resolveMedia,
  type MediaKind,
} from "./media-paths.ts";
import { type Ctx, fail, UvidError } from "./util.ts";

export interface PreviewParams {
  input?: string;
  paths?: string[];
  list?: string;
}

function runForeground(cmd: string, args: string[], ctx: Ctx): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ctx.cwd,
      stdio: "inherit",
      signal: ctx.signal,
      env: process.env,
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (signal) return reject(new UvidError(`${cmd} killed by ${signal}`));
      if (code && code !== 0) return reject(new UvidError(`${cmd} exited ${code}`));
      resolve();
    });
  });
}

async function openWithMpv(
  items: Array<{ path: string; kind: MediaKind }>,
  ctx: Ctx,
): Promise<void> {
  requireBin("mpv");
  const onlyAudio = items.every((i) => i.kind === "audio");
  const args = [
    "--force-window=immediate",
    "--keep-open=yes",
    "--osd-font-size=36",
    "--osd-msg1=${filename/no-ext}",
    "--osd-playing-msg=${filename}",
    "--osd-playing-msg-duration=1500",
  ];
  if (onlyAudio) args.push("--no-video");
  for (const it of items) args.push(it.path);
  ctx.log(`preview mpv (${items.length} file${items.length === 1 ? "" : "s"})`);
  await runForeground("mpv", args, ctx);
}

async function openWithImv(files: string[], ctx: Ctx, windowTitle?: string): Promise<void> {
  requireBin("imv");
  const args = ["-s", "shrink"];
  if (windowTitle) args.push("-w", windowTitle);
  args.push(...files);
  ctx.log(`preview imv (${files.length} image${files.length === 1 ? "" : "s"})`);
  await runForeground("imv", args, ctx);
}

export async function preview(p: PreviewParams, ctx: Ctx): Promise<void> {
  const files = collectPaths(p, ctx);
  if (files.length === 0) {
    fail("preview needs files: FILE… / -i FILE / --list FILE");
  }

  const items = await resolveMedia(files, ctx);
  const kinds = new Set(items.map((i) => i.kind));
  if (kinds.size > 1) {
    fail(`preview mixed types (${[...kinds].join("+")}): open one kind at a time`);
  }

  const kind = items[0].kind;
  if (kind === "image") {
    await openWithImv(
      items.map((i) => i.path),
      ctx,
      items.length === 1 ? path.basename(items[0].path) : `uvid preview (${items.length} images)`,
    );
    return;
  }
  await openWithMpv(items, ctx);
}
