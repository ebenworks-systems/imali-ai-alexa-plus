// The HTTP side: the MCP endpoint over Streamable HTTP, the simulator's files, and a small relay that
// passes the simulator's chat requests to an OpenAI-compatible model without the key reaching the browser.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp.js";
import { cleanShopId } from "./store.js";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const MAX_BODY = 1_000_000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(self)",
};
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id, x-imali-shop",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", ...SECURITY_HEADERS, ...CORS, ...headers });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
}

// Which shop a connection belongs to: our own header, AgentCore's pass-through custom header, a query
// parameter, or the signed-in user's name from a token the platform has already checked.
export function shopFrom(req, url) {
  const h = req.headers;
  const explicit = h["x-imali-shop"] || h["x-amzn-bedrock-agentcore-runtime-custom-shop"] || url.searchParams.get("shop");
  if (explicit) return cleanShopId(explicit);
  const auth = h.authorization;
  if (auth?.startsWith("Bearer ") && process.env.TRUST_PLATFORM_JWT === "1") {
    try {
      const claims = JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString("utf8"));
      return cleanShopId(claims.username || claims["cognito:username"] || claims.sub);
    } catch {
      /* fall through to the demo shop */
    }
  }
  return "demo";
}

export function createApp({ store, env = process.env, log = (event, data) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data })) } = {}) {
  const stateless = env.MCP_STATELESS === "1";
  const serveWeb = env.SERVE_WEB !== "0";
  // On AgentCore Runtime the platform may hand an initialize request a session id of its own; the server adopts it.
  const onePerVm = env.AGENTCORE === "1";
  const sessions = new Map();
  const seen = new Map();

  function touch(id) {
    seen.set(id, Date.now());
  }

  // Sessions idle for 30 minutes are closed so a long-running server does not collect them.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [id, at] of seen) if (at < cutoff) sessions.get(id)?.transport.close().catch(() => {});
  }, 60_000);
  sweeper.unref();

  async function handleMcp(req, res, url) {
    if (req.method === "POST") {
      const body = await readJson(req);
      if (stateless) {
        const server = createMcpServer({ store, shopId: shopFrom(req, url), log });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        return transport.handleRequest(req, res, body);
      }
      const id = req.headers["mcp-session-id"];
      if (id && sessions.has(id)) {
        touch(id);
        return sessions.get(id).transport.handleRequest(req, res, body);
      }
      if (!id || (onePerVm && isInitializeRequest(body))) {
        if (!isInitializeRequest(body)) return send(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Start with an initialize request" }, id: null });
        const shopId = shopFrom(req, url);
        const platformId = req.headers["mcp-session-id"];
        const server = createMcpServer({ store, shopId, log });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => platformId || randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server, shopId });
            touch(sid);
            log("session", { sid: sid.slice(0, 8), shopId, client: body.params?.clientInfo?.name, protocol: body.params?.protocolVersion });
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            seen.delete(sid);
          }
          server.close().catch(() => {});
        };
        await server.connect(transport);
        return transport.handleRequest(req, res, body);
      }
      return send(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    }
    if (req.method === "GET" || req.method === "DELETE") {
      if (stateless) return send(res, 405, "Method not allowed", { allow: "POST" });
      const id = req.headers["mcp-session-id"];
      const session = sessions.get(id);
      if (!session) return send(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      if (id) touch(id);
      return session.transport.handleRequest(req, res);
    }
    return send(res, 405, "Method not allowed", { allow: "GET, POST, DELETE" });
  }

  // The simulator's model relay. The key stays on this server; a judge may pass their own endpoint,
  // model and key in headers instead, which are used for that one request and never stored.
  const calls = [];
  async function handleAgent(req, res) {
    const now = Date.now();
    while (calls.length && calls[0] < now - 60_000) calls.shift();
    if (calls.length >= Number(env.AGENT_MAX_PER_MINUTE || 30)) return send(res, 429, { error: "Too many requests; wait a minute." });
    calls.push(now);
    const body = await readJson(req);
    if (!body || !Array.isArray(body.messages)) return send(res, 400, { error: "Expected messages" });
    const base = String(req.headers["x-llm-base-url"] || env.LLM_BASE_URL || "https://llm.ebenworks.co/v1").replace(/\/+$/, "");
    const key = req.headers["x-llm-key"] || env.LLM_API_KEY;
    const model = req.headers["x-llm-model"] || env.LLM_MODEL || "sonnet";
    if (!key) return send(res, 503, { error: "No model key: set LLM_API_KEY, or add your own endpoint and key in the simulator's settings." });
    const started = Date.now();
    const upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: body.messages.slice(-40), tools: body.tools, tool_choice: body.tools?.length ? "auto" : undefined, max_tokens: 700, temperature: 0.2 }),
      signal: AbortSignal.timeout(45_000),
    }).catch((err) => ({ ok: false, status: 502, json: async () => ({ error: String(err.message || err) }), headers: new Headers() }));
    const data = await upstream.json().catch(() => ({}));
    const ms = Date.now() - started;
    if (!upstream.ok) {
      log("model-error", { status: upstream.status, ms });
      return send(res, 502, { error: `The model endpoint answered ${upstream.status}.` });
    }
    const provider = upstream.headers.get("x-njere-provider") || "";
    log("model", { model, provider, ms, tool_calls: data.choices?.[0]?.message?.tool_calls?.length || 0 });
    send(res, 200, { message: data.choices?.[0]?.message ?? { role: "assistant", content: "" }, model: data.model || model, provider, ms });
  }

  async function handleStatic(req, res, url) {
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = normalize(join(WEB_DIR, decodeURIComponent(path)));
    if (!file.startsWith(WEB_DIR)) return send(res, 404, "Not found");
    try {
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache", ...SECURITY_HEADERS });
      res.end(data);
    } catch {
      send(res, 404, "Not found");
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "OPTIONS") return send(res, 204, "");
      if (url.pathname === "/mcp") return await handleMcp(req, res, url);
      if (url.pathname === "/health" || url.pathname === "/ping") return send(res, 200, { status: "Healthy", sessions: sessions.size });
      if (url.pathname === "/config.json")
        return send(res, 200, {
          mcpUrl: env.PUBLIC_MCP_URL || "/mcp",
          aws: env.AWS_MCP_URL ? { mcpUrl: env.AWS_MCP_URL, cognitoRegion: env.AWS_COGNITO_REGION || "us-east-1", cognitoClientId: env.AWS_COGNITO_CLIENT_ID || "" } : null,
          model: { relay: Boolean(env.LLM_API_KEY), name: env.LLM_MODEL || "sonnet", base: env.LLM_API_KEY ? (env.LLM_BASE_URL || "https://llm.ebenworks.co/v1").replace(/\/v1\/?$/, "") : "" },
        });
      if (serveWeb && url.pathname === "/agent/chat" && req.method === "POST") return await handleAgent(req, res);
      if (serveWeb && req.method === "GET") return await handleStatic(req, res, url);
      send(res, 404, "Not found");
    } catch (err) {
      log("error", { path: url.pathname, message: String(err?.message || err) });
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : "Something went wrong" });
      else res.end();
    }
  });
  server.on("close", () => clearInterval(sweeper));
  return { server, sessions };
}
