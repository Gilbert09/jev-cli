import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readFileSafe(dir, rel) {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

export function sha256(text) {
  return createHash("sha256").update(text ?? "").digest("hex").slice(0, 16);
}

/** Every tool_use block the assistant emitted, in order. */
export function toolCalls(transcript) {
  const out = [];
  for (const e of transcript) {
    if (e.type !== "assistant") continue;
    for (const b of e.message?.content ?? []) {
      if (b.type === "tool_use") out.push({ name: b.name, input: b.input ?? {} });
    }
  }
  return out;
}

export function bashCommands(transcript) {
  return toolCalls(transcript)
    .filter((t) => t.name === "Bash")
    .map((t) => String(t.input.command ?? ""));
}

/** Distinct file paths the agent opened with Read. */
export function filesRead(transcript) {
  return [
    ...new Set(
      toolCalls(transcript)
        .filter((t) => t.name === "Read")
        .map((t) => String(t.input.file_path ?? "")),
    ),
  ];
}

/** The assistant's final text, for tasks whose answer is prose. */
export function finalText(transcript) {
  let text = "";
  for (const e of transcript) {
    if (e.type !== "assistant") continue;
    for (const b of e.message?.content ?? []) {
      if (b.type === "text") text = b.text;
    }
  }
  return text;
}

/** Did the agent actually invoke a command matching `re`? */
export function ranCommand(transcript, re) {
  return bashCommands(transcript).some((c) => re.test(c));
}
