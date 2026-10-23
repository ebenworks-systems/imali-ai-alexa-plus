// The HTTP edge: which shop a caller reaches, and the model relay never sending our key elsewhere.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, shopFrom } from "../src/http.js";
import { MemoryStore } from "../src/store.js";

const token = (claims) => `Bearer x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const req = (headers) => ({ headers });
const url = new URL("http://localhost/mcp");

test("locally the shop comes from the header, or the demo shop", () => {
  assert.equal(shopFrom(req({ "x-imali-shop": "Rudo's Shop!" }), url, {}), "rudosshop");
  assert.equal(shopFrom(req({}), url, {}), "demo");
});

test("on AgentCore the shop is tied to the signed-in user, whatever the header says", () => {
  const env = { TRUST_PLATFORM_JWT: "1" };
  const judge = token({ username: "judge" });
  assert.equal(shopFrom(req({ authorization: judge, "x-amzn-bedrock-agentcore-runtime-custom-shop": "abc" }), url, env), "judge-abc");
  assert.equal(shopFrom(req({ authorization: judge }), url, env), "judge-main");
  assert.equal(shopFrom(req({ authorization: token({ username: "rudo-demo" }), "x-amzn-bedrock-agentcore-runtime-custom-shop": "abc" }), url, env), "rudo-demo-abc");
});

test("the model relay refuses a caller's endpoint without the caller's own key", async () => {
  const { server } = createApp({ store: new MemoryStore(), env: { LLM_API_KEY: "server-key-for-test" }, log: () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/agent/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-llm-base-url": "https://example.invalid/v1" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /your own API key/);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
