#!/usr/bin/env node
/**
 * uvid — Undefined Project video toolchain CLI.
 *
 * Thin adapter over src/spec.ts. Command style follows GitHub CLI:
 * `uvid <resource> <action> [flags]`. Flags are derived from each command's
 * TypeBox schema: camelCase property → --kebab-case flag; `input`/`output` also get
 * -i/-o aliases; boolean properties become --flag / --no-flag switches.
 */
import { commands, type CommandSpec } from "./spec.ts";
import { UvidError, kebab } from "./lib/util.ts";

const ALIASES: Record<string, string> = { input: "i", output: "o" };

interface FlagInfo {
  key: string;
  flag: string;      // --kebab-case
  short?: string;    // -i / -o
  type: string;      // string | number | boolean
  required: boolean;
  description: string;
}

function flagsOf(cmd: CommandSpec): FlagInfo[] {
  const required: string[] = (cmd.params as any).required || [];
  return Object.entries((cmd.params as any).properties).map(([key, prop]: [string, any]) => ({
    key,
    flag: `--${kebab(key)}`,
    short: ALIASES[key] ? `-${ALIASES[key]}` : undefined,
    type: prop.type,
    required: required.includes(key),
    description: prop.description || "",
  }));
}

function commandUsage(cmd: CommandSpec): string {
  const parts = [`uvid ${cmd.path.join(" ")}`];
  for (const f of flagsOf(cmd)) {
    const name = f.short ? `${f.short} ${f.type.toUpperCase()}` : f.type === "boolean" ? f.flag : `${f.flag} ${f.type.toUpperCase()}`;
    parts.push(f.required ? name : `[${name}]`);
  }
  return parts.join(" ");
}

function printGlobalHelp(): void {
  const lines = [
    "uvid — Undefined Project video toolchain",
    "",
    "Usage:",
    "  uvid <resource> <action> [flags]",
    "",
    "Commands:",
    ...commands.map((c) => `  ${c.path.join(" ").padEnd(24)} ${c.summary}`),
    "",
    "Run `uvid <command> --help` for command flags.",
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
    ...flagsOf(cmd).map((f) => {
      const names = [f.short, f.flag].filter(Boolean).join(", ");
      const req = f.required ? " (required)" : "";
      return `  ${names.padEnd(26)} ${f.type}${req}  ${f.description}`;
    }),
  ];
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
  for (let i = 0; i < args.length; i++) {
    let token = args[i];
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
    // Non-boolean flags always consume one value (allows negative numbers: --lufs -12).
    const raw = inlineValue !== undefined ? inlineValue : args[++i];
    if (raw === undefined) throw new UvidError(`missing value for ${token}`);
    if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UvidError(`invalid number for ${token}: ${raw}`);
      params[f.key] = n;
    } else {
      params[f.key] = raw;
    }
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

  // Longest path match so multi-segment paths win over any shorter prefix.
  const cmd = [...commands]
    .sort((a, b) => b.path.length - a.path.length)
    .slice()
    .sort((a, b) => b.path.length - a.path.length)
    .find((c) => c.path.every((part, i) => argv[i] === part));
  if (!cmd) throw new UvidError(`unknown command: ${argv.slice(0, 3).join(" ")}`);

  const rest = argv.slice(cmd.path.length);
  if (rest.includes("--help") || rest.includes("-h")) {
    printCommandHelp(cmd);
    return;
  }

  const params = parseFlags(cmd, rest);
  await cmd.run(params, { cwd: process.cwd(), log: (line) => console.log(line) });
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
