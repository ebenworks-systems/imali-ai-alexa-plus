// Starts the server: the MCP endpoint at /mcp and, unless SERVE_WEB=0, the simulated Alexa+ screen at /.
// On AgentCore Runtime the container listens on 0.0.0.0:8000 as the platform's MCP contract asks.

import { createApp } from "./http.js";
import { storeFromEnv } from "./store.js";

const env = process.env;
const port = Number(env.PORT || (env.AGENTCORE === "1" ? 8000 : 8787));
const host = env.HOST || (env.AGENTCORE === "1" ? "0.0.0.0" : "127.0.0.1");
const { server } = createApp({ store: storeFromEnv(env), env });

server.listen(port, host, () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event: "listening", url: `http://${host}:${port}`, mcp: `http://${host}:${port}/mcp`, store: env.IMALI_STORE || "file", stateless: env.MCP_STATELESS === "1" }));
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
