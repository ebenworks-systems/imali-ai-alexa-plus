// The simulator's model relay, shared by the local server and the hosted page's function. It passes a chat
// request with the MCP tools to an OpenAI-compatible endpoint. Our key goes only to our own endpoint; a caller who
// names an endpoint must bring their own key, which is used for that request and never stored.

export async function relayChat({ body, headers, env, fetchImpl = fetch }) {
  if (!body || !Array.isArray(body.messages)) return { status: 400, json: { error: "Expected messages" } };
  const own = Boolean(headers["x-llm-key"]);
  if (headers["x-llm-base-url"] && !own) return { status: 400, json: { error: "Give your own API key with your own model endpoint." } };
  const base = String((own && headers["x-llm-base-url"]) || env.LLM_BASE_URL || "https://llm.ebenworks.co/v1").replace(/\/+$/, "");
  const key = own ? headers["x-llm-key"] : env.LLM_API_KEY;
  const model = (own && headers["x-llm-model"]) || env.LLM_MODEL || "sonnet";
  if (!key) return { status: 503, json: { error: "No model key: set LLM_API_KEY, or add your own endpoint and key in the simulator's settings." } };
  const started = Date.now();
  const upstream = await fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: body.messages.slice(-40), tools: body.tools, tool_choice: body.tools?.length ? "auto" : undefined, max_tokens: 700, temperature: 0.2 }),
    signal: AbortSignal.timeout(45_000),
  }).catch((err) => ({ ok: false, status: 502, json: async () => ({ error: String(err.message || err) }), headers: new Headers() }));
  const data = await upstream.json().catch(() => ({}));
  const ms = Date.now() - started;
  if (!upstream.ok) return { status: 502, json: { error: upstream.status === 429 ? "The model is busy right now. Try again in a minute, or tap a suggestion." : `The model endpoint answered ${upstream.status}.` }, log: { status: upstream.status, ms } };
  const provider = upstream.headers.get("x-njere-provider") || "";
  const via = /bedrock/i.test(provider) ? "Amazon Bedrock" : own ? "your endpoint" : /llm\.ebenworks\.co/.test(base) ? "Ebenworks model gateway" : "";
  return {
    status: 200,
    json: { message: data.choices?.[0]?.message ?? { role: "assistant", content: "" }, model: data.model || model, provider, via, ms },
    log: { model, provider, ms, tool_calls: data.choices?.[0]?.message?.tool_calls?.length || 0 },
  };
}
