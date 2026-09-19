import { defineConfig } from "tsup";

// One bundled file per entry. Hooks run on every tool call, so startup cost
// matters more than build elegance: no dependency resolution at runtime.
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "mcp-server": "src/capabilities/rank/server.ts",
    fixtures: "src/fixtures/run.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
});
