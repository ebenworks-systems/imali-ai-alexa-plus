// Bundles the official MCP client for the simulator page, so the browser speaks MCP itself.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await build({
  entryPoints: [fileURLToPath(new URL("../web/src/mcp-entry.js", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: fileURLToPath(new URL("../web/vendor/mcp.js", import.meta.url)),
  legalComments: "eof",
  logLevel: "warning",
});
