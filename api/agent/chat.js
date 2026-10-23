// The hosted page's model relay (a Vercel function). It answers only a caller signed in through the same Amazon
// Cognito pool that guards the MCP server on AgentCore, and then relays like the local server does.

import { verifyAccessToken } from "../../src/cognito.js";
import { relayChat } from "../../src/relay.js";

const recent = new Map(); // per signed-in user, within this instance: a guard against a runaway loop

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const env = process.env;
  let claims;
  try {
    claims = await verifyAccessToken(String(req.headers.authorization || "").replace(/^Bearer /, ""), {
      region: env.AWS_COGNITO_REGION || "us-east-1",
      poolId: env.AWS_COGNITO_POOL_ID,
      clientId: env.AWS_COGNITO_CLIENT_ID,
    });
  } catch {
    return res.status(401).json({ error: "Sign in with the judge account under Settings first." });
  }
  const user = claims.username || claims.sub;
  const now = Date.now();
  const times = (recent.get(user) || []).filter((t) => t > now - 60_000);
  if (times.length >= 30) return res.status(429).json({ error: "Too many requests; wait a minute." });
  recent.set(user, [...times, now]);
  const size = Number(req.headers["content-length"] || 0);
  if (size > 1_000_000) return res.status(413).json({ error: "too large" });
  const out = await relayChat({ body: req.body, headers: req.headers, env });
  if (out.log) console.log(JSON.stringify({ event: out.status === 200 ? "model" : "model-error", user, ...out.log }));
  return res.status(out.status).json(out.json);
}
