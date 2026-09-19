import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { describeFailure } from "../../core/types.js";
import { debug } from "../../core/log.js";
import { TUNING, TOOL_DESCRIPTION } from "./questions.js";
import { rankCandidates, type RankSuccess } from "./rank.js";

/**
 * The MCP surface for `rank`.
 *
 * Unlike the hook capabilities, nothing here fires automatically — Claude
 * decides to call this, which makes the tool description (in `questions.ts`)
 * load-bearing: a description that only says what the tool does gets called far
 * less than one that says when to call it.
 *
 * stdio is the transport, so stdout carries JSON-RPC frames and NOTHING else.
 * Diagnostics go to stderr via `debug`.
 */

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe("The question you are trying to answer, in plain words. Not a search term."),
  candidates: z
    .array(
      z.object({
        id: z.string().optional().describe("Your own id for this candidate; echoed back."),
        path: z.string().min(1).describe("Path to the file, absolute or relative to cwd."),
        snippet: z
          .string()
          .optional()
          .describe("Content to judge the file by. Omit to have a bounded head of the file read."),
      }),
    )
    .describe("Every plausible file. Hundreds are fine; they are batched automatically."),
  topK: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`How many files to return. Default ${TUNING.defaultTopK}, max ${TUNING.maxTopK}.`),
};

function renderPresence(result: RankSuccess): string {
  const pct = Math.round(result.present * 100);
  if (result.presentConfidence < TUNING.presentConfidenceFloor) {
    return `present: ${pct}% (UNCERTAIN — jev could not tell whether the answer is in this set; treat the ranking as a weak hint)`;
  }
  if (result.present < TUNING.presentThreshold) {
    return `present: ${pct}% — the answer is probably NOT in these candidates. Widen the search rather than reading the files below; the ranking is a forced choice and names a file regardless.`;
  }
  return `present: ${pct}% — the answer is probably in these candidates.`;
}

function render(result: RankSuccess): string {
  if (result.considered === 0) return "No candidates were supplied, so there is nothing to rank.";

  const lines: string[] = [renderPresence(result), ""];
  lines.push(`ranked ${result.ranked.length} of ${result.considered} candidates:`);
  result.ranked.forEach((entry, index) => {
    lines.push(
      `  ${index + 1}. ${entry.path}  [id=${entry.id} score=${entry.score.toFixed(3)} rounds=${entry.rounds}]`,
    );
  });

  if (result.truncated) {
    lines.push("", "note: the candidate list was cut to the configured ceiling before ranking.");
  }
  return lines.join("\n");
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "jev-rank", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "rank",
    {
      title: "Rank files by relevance to a question",
      description: TOOL_DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const result = await rankCandidates({
        query: args.query,
        candidates: args.candidates,
        topK: args.topK,
      });

      if (!result.ok) {
        debug("rank", { error: result.error });
        // Never fabricate an order from a failed call: say what broke and let
        // Claude fall back to reading files itself.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `rank failed: ${describeFailure(result.error)}.\n` +
                "No ranking was produced. Fall back to reading the candidate files yourself.",
            },
          ],
        };
      }

      debug("rank", {
        considered: result.considered,
        rounds: result.rounds,
        calls: result.calls,
        present: result.present,
      });

      return { content: [{ type: "text" as const, text: render(result) }] };
    },
  );

  return server;
}

export async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
