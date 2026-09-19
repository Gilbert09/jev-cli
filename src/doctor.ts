import { noul } from "@typesafe-ai/sdk";
import { loadConfig } from "./core/config.js";
import { ask } from "./core/jev.js";
import { describeFailure } from "./core/types.js";

/** `jev doctor` — verify configuration and live API access. */
export async function doctor(): Promise<number> {
  const config = loadConfig();
  const out = (s: string) => process.stdout.write(s + "\n");

  out("jev doctor");
  out(`  model            ${config.model}`);
  out(`  api key          ${config.apiKey ? "present" : "MISSING"}`);
  for (const cap of ["guard", "screen", "done", "rank"] as const) {
    out(`  ${cap.padEnd(16)} ${config[cap].enabled ? "enabled" : "disabled"} (${config[cap].timeoutMs}ms)`);
  }

  if (!config.apiKey) {
    out("");
    out("  Set TYPESAFE_API_KEY, or add \"apiKey\" to ~/.jev/config.json.");
    return 1;
  }

  out("");
  out("  probing the Jev API...");
  const result = await ask({
    capability: "guard",
    state: { probe: "the sky is blue" },
    questions: { ok: noul("Is `probe` a statement about the sky?") },
    noCache: true,
  });

  if (!result.ok) {
    out(`  FAILED: ${describeFailure(result.error)}`);
    return 1;
  }
  out(`  ok (${result.ms}ms)`);
  return 0;
}
