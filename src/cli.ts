#!/usr/bin/env node
/**
 * uvid CLI — thin adapter over src/spec.ts.
 *
 * Style: `uvid <family> <action> [flags]`
 * Flags from TypeBox: camelCase → --kebab-case; input→-i, output→-o;
 * boolean → --flag / --no-flag.
 *
 * Diagnostics → stderr. Main artifact → -o file or stdout (see lib/io.ts).
 */
import { commands, type CommandSpec } from "./spec.ts";
import { UvidError, kebab } from "./lib/util.ts";

const ALIASES: Record<string, string> = { input: "i", output: "o", format: "f" };

interface FlagInfo {
  key: string;
  flag: string;
  short?: string;
  type: string;
  required: boolean;
  description: string;
}

function flagsOf(cmd: CommandSpec): FlagInfo[] {
  const required: string[] = (cmd.params as any).required || [];
  return Object.entries((cmd.params as any).properties).map(([key, prop]: [string, any]) => {
    // TypeBox arrays: { type: 'array', items: … } or anyOf wrappers — treat as array when items present.
    const type =
      prop.type === "array" || prop.items
        ? "array"
        : prop.type || "string";
    return {
      key,
      flag: `--${kebab(key)}`,
      short: ALIASES[key] ? `-${ALIASES[key]}` : undefined,
      type,
      required: required.includes(key),
      description: prop.description || "",
    };
  });
}

function commandUsage(cmd: CommandSpec): string {
  const parts = [`uvid ${cmd.path.join(" ")}`];
  for (const f of flagsOf(cmd)) {
    // paths array is filled from trailing FILE… when positionals: true
    if (cmd.positionals && f.key === "paths") continue;
    const name =
      f.short && f.type !== "boolean" && f.type !== "array"
        ? `${f.short} ${f.type.toUpperCase()}`
        : f.type === "boolean"
          ? f.flag
          : f.type === "array"
            ? `${f.flag} A,B,…`
            : `${f.flag} ${f.type.toUpperCase()}`;
    parts.push(f.required ? name : `[${name}]`);
  }
  if (cmd.positionals) parts.push("[FILE…]");
  return parts.join(" ");
}

function printGlobalHelp(): void {
  const lines = [
    "uvid — atomic media filters (analyze / generate)",
    "",
    "Usage:",
    "  uvid <family> <action> [flags]",
    "  -i FILE   input file  (omit → stdin)",
    "  -o FILE   write main artifact to file; stdout prints that absolute path",
    "            (omit -o → main artifact on stdout)",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.path.join(" ").padEnd(24)} ${c.summary}`),
    "",
    "Run `uvid <command> --help` for flags.",
  ];
  console.log(lines.join("\n"));
}

function printCommandHelp(cmd: CommandSpec): void {
  const lines = [
    `uvid ${cmd.path.join(" ")} — ${cmd.summary}`,
    "",
    "Usage:",
    `  ${commandUsage(cmd)}`,
    "",
    "Flags:",
    ...flagsOf(cmd)
      .filter((f) => !(cmd.positionals && f.key === "paths"))
      .map((f) => {
        const names = [f.short, f.flag].filter(Boolean).join(", ");
        const req = f.required ? " (required)" : "";
        return `  ${names.padEnd(28)} ${f.type}${req}  ${f.description}`;
      }),
  ];
  if (cmd.description) {
    lines.push("", cmd.description);
  }
  console.log(lines.join("\n"));
}

function parseFlags(cmd: CommandSpec, args: string[]): any {
  const flags = flagsOf(cmd);
  const byFlag = new Map<string, FlagInfo>();
  for (const f of flags) {
    byFlag.set(f.flag, f);
    if (f.short) byFlag.set(f.short, f);
    if (f.type === "boolean") byFlag.set(`--no-${kebab(f.key)}`, f);
  }

  const params: any = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    let token = args[i];

    // Trailing / intermixed file paths for commands that opt in (e.g. generate sheet).
    if (!token.startsWith("-") && cmd.positionals) {
      positionals.push(token);
      continue;
    }

    let inlineValue: string | undefined;
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 0) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    const f = byFlag.get(token);
    if (!f) throw new UvidError(`unknown flag for \`uvid ${cmd.path.join(" ")}\`: ${token}`);

    if (f.type === "boolean") {
      params[f.key] = !token.startsWith("--no-");
      continue;
    }
    const raw = inlineValue !== undefined ? inlineValue : args[++i];
    if (raw === undefined) throw new UvidError(`missing value for ${token}`);
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UvidError(`invalid number for ${token}: ${raw}`);
      params[f.key] = n;
    } else if (f.type === "array") {
      // Allow repeated flags or comma-separated once; positionals preferred for files.
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      params[f.key] = [...(params[f.key] || []), ...parts];
    } else {
      params[f.key] = raw;
    }
  }

  if (positionals.length) {
    params.paths = [...(params.paths || []), ...positionals];
  }

  for (const f of flags) {
    if (f.required && params[f.key] === undefined) {
      throw new UvidError(`missing required ${[f.short, f.flag].filter(Boolean).join("/")}`);
    }
  }
  return params;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printGlobalHelp();
    return;
  }

  const cmd = [...commands]
    .sort((a, b) => b.path.length - a.path.length)
    .find((c) => c.path.every((part, i) => argv[i] === part));
  if (!cmd) throw new UvidError(`unknown command: ${argv.slice(0, 3).join(" ")}`);

  const rest = argv.slice(cmd.path.length);
  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(cmd);
    return;
  }

  const params = parseFlags(cmd, rest);
  // Diagnostics always on stderr so stdout stays clean for pipes.
  await cmd.run(params, {
    cwd: process.cwd(),
    log: (line) => console.error(line),
  });
}

main(process.argv.slice(2)).catch((error: any) => {
  if (error instanceof UvidError) {
    console.error(`uvid: ${error.message}`);
    console.error("Run `uvid --help` for usage.");
  } else {
    console.error(error?.stack || error?.message || String(error));
  }
  process.exit(1);
});
