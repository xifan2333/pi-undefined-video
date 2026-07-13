/**
 * undefined-video pi extension — thin adapter over src/spec.ts.
 *
 * Every uvid command is registered as a pi tool with the same TypeBox schema
 * the CLI uses, executed in-process (async, AbortSignal). No subprocess spawn:
 * extension and CLI share library code so flags never drift.
 *
 * Tool names: `uvid_<family>_<action>` e.g. uvid_analyze_loudness.
 *
 * I/O in tool host:
 *   - pass explicit `input` / `output` paths (cwd-relative or absolute)
 *   - omit-output JSON: payload text is returned in the tool result
 *   - binary generate requires `output` path
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commands } from "../src/spec.ts";

export default function (pi: ExtensionAPI) {
  for (const cmd of commands) {
    const cliName = `uvid ${cmd.path.join(" ")}`;
    pi.registerTool({
      name: `uvid_${cmd.path.join("_")}`,
      label: cliName,
      description: cmd.description || cmd.summary,
      parameters: cmd.params,
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        const lines: string[] = [];
        await cmd.run(params, {
          cwd: process.cwd(),
          signal,
          toolHost: true,
          log: (line) => lines.push(line),
        });
        return {
          content: [{ type: "text", text: lines.join("\n") || `${cliName}: done` }],
          details: { command: cliName },
        };
      },
    });
  }
}
