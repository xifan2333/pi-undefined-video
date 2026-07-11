/**
 * undefined-video pi extension — thin adapter over src/spec.ts.
 *
 * Every uvid command is registered as a pi tool with the exact same TypeBox schema
 * the CLI uses, and executed in-process (async, cancellable via AbortSignal). No
 * subprocess spawning: the extension and the CLI share the same library code, so
 * behavior and flags never drift. Tool names follow `uvid_<resource>_<action>`.
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
