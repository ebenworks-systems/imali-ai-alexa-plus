// The simulated Alexa+ experience. This page is a real MCP client (the official TypeScript SDK, bundled):
// it initializes over Streamable HTTP, lists the server's tools, hands them to an agent model, calls the
// tools the model picks, answers the server's elicitation requests, and hosts the server's MCP Apps views.
// The model chooses tools and words; every figure it may say must already be in the books' answers.

import { heardYes } from "./answer.js";
import { Client, ElicitRequestSchema, StreamableHTTPClientTransport } from "./vendor/mcp.js";

const $ = (id) => document.getElementById(id);
const els = { screen: $("screen"), said: $("said"), reply: $("reply"), cards: $("cards"), state: $("state"), clock: $("clock"), traffic: $("traffic"), mic: $("mic"), input: $("say-input") };
const APP_MIME = "text/html;profile=mcp-app";
const UI_PROTOCOL = "2026-01-26";
const SETTINGS_KEY = "imali-ai-alexa-settings";
const PASS_KEY = "imali-ai-alexa-aws-pass";
const TRACE = "io.ebenworks.imali/trace";
const LAST_SESSION_KEY = "imali-ai-alexa-last-session";

// Settings stay in this browser. The AWS password stays in this tab's session storage only, and a copy an older
// version left in local storage is moved there.
const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
if (stored.awsPass) {
  sessionStorage.setItem(PASS_KEY, stored.awsPass);
  delete stored.awsPass;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
}
const settings = { endpoint: "local", mcpUrl: "", shop: "", awsUser: "", llmBase: "", llmModel: "", llmKey: "", voice: true, ...stored, awsPass: sessionStorage.getItem(PASS_KEY) || "" };
function saveSettings() {
  const { awsPass, ...rest } = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(rest));
  if (awsPass) sessionStorage.setItem(PASS_KEY, awsPass);
  else sessionStorage.removeItem(PASS_KEY);
}
let config = { mcpUrl: "/mcp", aws: null, model: { relay: false } };
let client;
let transport;
let tools = [];
let modelTools = [];
let instructions = "";
let history = [];
let busy = false;
let lastInputWasVoice = false;
let pendingConfirm = null;
let awsAccessToken = "";
const uiCache = new Map();

// ---- small helpers ---------------------------------------------------------------------------

function setState(state, label) {
  els.screen.dataset.state = state;
  els.state.textContent = label ?? { idle: "Ready", listening: "Listening", thinking: "Working", speaking: "Speaking" }[state] ?? "";
}

// One line per JSON-RPC message, newest first. A line with a message opens to show it in full.
function logTraffic(dir, text, note = "", cls = "", message = null) {
  const li = document.createElement("li");
  li.className = `${dir === "←" ? "in" : dir === "↳" ? "nested" : "out"} ${cls}`.trim();
  li.innerHTML = `<span class="dir">${dir}</span><code></code><small></small>`;
  li.querySelector("code").textContent = text;
  li.querySelector("small").textContent = note;
  if (message) {
    const more = document.createElement("details");
    more.innerHTML = "<summary>JSON</summary><pre></pre>";
    const json = JSON.stringify(message, null, 2);
    more.querySelector("pre").textContent = json.length > 6000 ? `${json.slice(0, 6000)}\n…` : json;
    li.append(more);
  }
  els.traffic.prepend(li);
  while (els.traffic.children.length > 80) els.traffic.lastChild.remove();
}

// The books server's own calls to the supplier network's MCP server, which it reports in the result's _meta.
function logTrace(trace) {
  for (const t of trace) logTraffic("↳", `${t.server}: ${t.method}${t.tool ? ` ${t.tool}` : ""}`, `${t.ms} ms`, t.ok === false ? "ask" : "", t.request || t.response ? { request: t.request, response: t.response } : null);
}

function chip(id, text, ok) {
  const el = $(id);
  el.innerHTML = ok === undefined ? "" : "<i></i>";
  el.append(text);
  if (ok !== undefined) el.classList.toggle("ok", ok);
}

function tickClock() {
  els.clock.textContent = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Harare", hour: "2-digit", minute: "2-digit" }).format(new Date());
}

function shopId() {
  if (!settings.shop) {
    settings.shop = `shop-${Math.random().toString(36).slice(2, 8)}`;
    saveSettings();
  }
  return settings.shop;
}

// ---- connecting: initialize, tools/list ------------------------------------------------------

async function awsToken() {
  const region = config.aws?.cognitoRegion || "us-east-1";
  const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth" },
    body: JSON.stringify({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: config.aws?.cognitoClientId, AuthParameters: { USERNAME: settings.awsUser, PASSWORD: settings.awsPass } }),
  });
  const data = await res.json();
  if (!data.AuthenticationResult) throw new Error("The AWS sign-in was refused. Check the user and password in Settings.");
  awsAccessToken = data.AuthenticationResult.AccessToken;
  return awsAccessToken;
}

async function connect() {
  setState("thinking", "Connecting");
  chip("chip-proto", "Connecting…", false);
  if (client) await client.close().catch(() => {});
  const headers = {};
  let url;
  if (settings.endpoint === "aws") {
    url = new URL(settings.mcpUrl || config.aws?.mcpUrl);
    headers.authorization = `Bearer ${await awsToken()}`;
    headers["X-Amzn-Bedrock-AgentCore-Runtime-Custom-Shop"] = shopId();
  } else {
    url = new URL(settings.endpoint === "custom" && settings.mcpUrl ? settings.mcpUrl : config.mcpUrl, location.href);
    headers["x-imali-shop"] = shopId();
  }

  client = new Client(
    { name: "imali-ai-alexa-plus-simulator", title: "Imali AI for Alexa+ (simulated)", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} }, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [APP_MIME] } } } },
  );
  client.setRequestHandler(ElicitRequestSchema, (req) => askOwner(req.params));
  transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });

  // Log every JSON-RPC message this page sends and receives; each line opens to show the message itself.
  const started = new Map();
  const send = transport.send.bind(transport);
  transport.send = async (msg, opts) => {
    if (msg.method) {
      if (msg.id !== undefined) started.set(msg.id, performance.now());
      const what = msg.method === "tools/call" ? `tools/call ${msg.params.name}` : msg.method === "resources/read" ? `resources/read ${msg.params.uri}` : msg.method;
      logTraffic("→", what, "", "", msg);
    } else if (msg.result) logTraffic("→", "elicitation answer", msg.result.action, "ask", msg);
    return send(msg, opts);
  };
  const t0 = performance.now();
  await client.connect(transport);
  const onmessage = transport.onmessage;
  let heardSteps = false;
  transport.onmessage = (msg, extra) => {
    if (msg.method === "elicitation/create") logTraffic("←", "elicitation/create", "server asks the owner", "ask", msg);
    else if (msg.method === "notifications/message" && msg.params?.logger === "supplier-network") {
      // The books server reports each of its own calls to the supplier network as it makes it.
      heardSteps = true;
      logTrace([msg.params.data]);
    } else if (msg.id !== undefined && started.has(msg.id)) {
      const ms = Math.round(performance.now() - started.get(msg.id));
      started.delete(msg.id);
      const trace = msg.result?._meta?.[TRACE];
      if (Array.isArray(trace) && !heardSteps) logTrace(trace);
      heardSteps = false;
      // A view's HTML is long and adds nothing to read here, so its text is shortened.
      const shown = msg.result?.contents?.some((c) => c.mimeType === APP_MIME) ? { ...msg, result: { ...msg.result, contents: msg.result.contents.map((c) => ({ ...c, text: `${c.text.slice(0, 200)}…` })) } } : msg;
      logTraffic("←", msg.error ? `error ${msg.error.code}` : "result", `${ms} ms`, "", shown);
    } else if (msg.method) logTraffic("←", msg.method, "", "", msg);
    onmessage?.(msg, extra);
  };

  const server = client.getServerVersion();
  instructions = client.getInstructions() || "";
  logTraffic("←", `protocolVersion ${transport.protocolVersion}`, `${Math.round(performance.now() - t0)} ms`);
  tools = (await client.listTools()).tools;
  modelTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

  $("f-proto").textContent = `${transport.protocolVersion} (negotiated)`;
  $("f-server").textContent = `${server?.name} ${server?.version}`;
  $("f-endpoint").textContent = settings.endpoint === "aws" ? "AWS · Bedrock AgentCore Runtime" : url.host + url.pathname;
  $("f-session").textContent = transport.sessionId ? `${transport.sessionId.slice(0, 8)}… · shop ${shopId()}` : `stateless · shop ${shopId()}`;
  // The page remembers the last session it opened for this shop, so a reload shows a new session reading the same books.
  const earlier = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || "{}");
  const isNew = transport.sessionId && earlier.shop === shopId() && earlier.id && earlier.id !== transport.sessionId;
  $("f-earlier-row").hidden = !isNew;
  if (isNew) $("f-earlier").textContent = `${earlier.id.slice(0, 8)}… (before this page load), same shop`;
  if (transport.sessionId) localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ shop: shopId(), id: transport.sessionId }));
  chip("chip-proto", `MCP ${transport.protocolVersion}`, true);
  chip("chip-tools", `${tools.length} tools`);
  chip("chip-endpoint", settings.endpoint === "aws" ? "AWS AgentCore" : "This computer");
  setState("idle");
  // The idle screen shows the shelves, the way a counter display would.
  if (!els.cards.children.length) await runTool("get_stock", {}).catch(() => {});
}

// ---- elicitation: the server asks the owner -------------------------------------------------

function askOwner(params) {
  return new Promise((resolve) => {
    const form = $("confirm");
    $("confirm-q").textContent = params.message;
    const fields = $("confirm-fields");
    fields.innerHTML = "";
    const props = params.requestedSchema?.properties || {};
    for (const [key, schema] of Object.entries(props)) {
      const options = schema.oneOf || (schema.enum || []).map((v, i) => ({ const: v, title: schema.enumNames?.[i] || v }));
      if (schema.type === "string" && options.length) {
        const box = document.createElement("div");
        box.innerHTML = `<div class="field-title"></div><div class="opts"></div>`;
        box.querySelector(".field-title").textContent = schema.title || key;
        for (const o of options) {
          const label = document.createElement("label");
          label.innerHTML = `<input type="radio" name="${key}">`;
          label.querySelector("input").value = o.const;
          label.querySelector("input").checked = o.const === schema.default;
          label.append(o.title);
          box.querySelector(".opts").append(label);
        }
        fields.append(box);
      }
    }
    form.hidden = false;
    $("confirm-yes").focus({ preventScroll: true });
    const done = (action) => {
      form.hidden = true;
      pendingConfirm = null;
      const content = {};
      for (const [key, schema] of Object.entries(props)) {
        if (schema.type === "boolean") content[key] = action === "accept";
        else {
          const picked = fields.querySelector(`input[name="${key}"]:checked`);
          if (picked) content[key] = picked.value;
        }
      }
      resolve(action === "accept" ? { action, content } : { action });
    };
    pendingConfirm = done;
    form.onsubmit = (e) => { e.preventDefault(); done("accept"); };
    $("confirm-no").onclick = () => done("decline");
    speak(/\?\s*$/.test(params.message) ? params.message : `${params.message} Shall I go ahead?`, { listenAfter: true });
  });
}

// ---- MCP Apps: hosting the server's views ----------------------------------------------------

function toolMeta(name) {
  const t = tools.find((x) => x.name === name);
  return t?._meta?.ui?.resourceUri || t?._meta?.["ui/resourceUri"];
}

async function viewHtml(uri) {
  if (!uiCache.has(uri)) {
    const res = await client.readResource({ uri });
    const item = res.contents.find((c) => c.mimeType === APP_MIME) || res.contents[0];
    uiCache.set(uri, item.text);
  }
  return uiCache.get(uri);
}

async function showCard(name, args, result) {
  const uri = toolMeta(name);
  if (!uri) return;
  const html = await viewHtml(uri);
  const frame = document.createElement("iframe");
  frame.title = `${name} card`;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = html;
  const tool = tools.find((t) => t.name === name);
  const reply = (id, payload) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", id, ...payload }, "*");
  const notify = (method, params) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const onMessage = async (event) => {
    if (event.source !== frame.contentWindow) return;
    const m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/initialize") {
      reply(m.id, { result: { protocolVersion: UI_PROTOCOL, hostInfo: { name: "imali-ai-alexa-plus-simulator", version: "1.0.0" }, hostCapabilities: { serverTools: {} }, hostContext: { theme: "light", displayMode: "inline", locale: "en-US", timeZone: "Africa/Harare", platform: "web", toolInfo: { tool } } } });
    } else if (m.method === "ui/notifications/initialized") {
      notify("ui/notifications/tool-input", { arguments: args });
      notify("ui/notifications/tool-result", result);
    } else if (m.method === "ui/notifications/size-changed") {
      if (m.params?.height) frame.style.height = `${Math.min(m.params.height, 900)}px`;
    } else if (m.method === "tools/call") {
      // A view may call this server's tools through the host, like the stock card's Reorder button.
      try {
        const out = await runTool(m.params.name, m.params.arguments || {});
        reply(m.id, { result: out });
        const line = out.structuredContent?.ok === false ? out.structuredContent.question : out.structuredContent?.speech;
        if (line) {
          history.push({ role: "assistant", content: line });
          say(line);
        }
      } catch (err) {
        reply(m.id, { error: { code: -32603, message: String(err.message || err) } });
      }
    } else if (m.id !== undefined && m.method) {
      reply(m.id, { error: { code: -32601, message: "Not supported by this host" } });
    }
  };
  window.addEventListener("message", onMessage);
  els.cards.prepend(frame);
  for (const old of [...els.cards.children].slice(1)) old.remove();
}

// ---- calling tools ---------------------------------------------------------------------------

// Each call carries a request id in _meta, so a retry or a double tap is recorded once by the server.
async function runTool(name, args, requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) {
  const result = await client.callTool({ name, arguments: args, _meta: { "io.ebenworks.imali/request-id": requestId } });
  await showCard(name, args, result).catch((err) => logTraffic("←", "view failed", String(err.message || err)));
  return result;
}

// ---- the agent model ------------------------------------------------------------------------

function systemPrompt() {
  return `You are Imali AI, speaking through a voice assistant on a small shop's counter (a simulated Alexa+ experience). The owner talks to you while serving customers.

${instructions}

Speak like a calm, quick shop assistant. When a tool's "speech" line answers the owner, say that line as it is and stop: no offers, no follow-up questions, no figure of your own. Ask a question only when a tool asks one. If the owner's words are unclear, ask one short question. Today's date in the shop: ${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(new Date())}.`;
}

function modelHeaders() {
  const h = { "content-type": "application/json" };
  // The hosted page's relay answers only a caller signed in to the same pool as the MCP server.
  if (config.hosted && awsAccessToken) h.authorization = `Bearer ${awsAccessToken}`;
  if (settings.llmKey) {
    h["x-llm-key"] = settings.llmKey;
    if (settings.llmBase) h["x-llm-base-url"] = settings.llmBase;
    if (settings.llmModel) h["x-llm-model"] = settings.llmModel;
  }
  return h;
}

// A failure to get any answer from the model is marked, so the turn can fall back to calling a suggestion's tool.
function modelDown(message) {
  const err = new Error(message);
  err.modelDown = true;
  return err;
}

async function askModel() {
  const t0 = performance.now();
  const post = () =>
    fetch("agent/chat", { method: "POST", headers: modelHeaders(), body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt() }, ...history], tools: modelTools }) }).catch((err) => {
      throw modelDown(`The model relay could not be reached (${err.message || err}).`);
    });
  let res = await post();
  if (res.status === 401 && config.hosted && settings.awsUser) {
    await awsToken();
    res = await post();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw modelDown(data.error || `The model relay answered ${res.status}`);
  const label = settings.llmKey ? `${settings.llmModel || "your model"} (your endpoint)` : `${prettyModel(data.model)}${data.via ? ` · ${data.via}` : ""}`;
  $("f-model").textContent = `${label} · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  return data.message;
}

function prettyModel(id = "") {
  const m = String(id).match(/^claude-(\w+)-(\d+)-(\d+)/);
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  if (/nova/i.test(id)) return `Amazon ${id.replace(/^.*?(nova[\w.-]*).*$/i, "$1").replace(/-v\d.*$/, "").replace(/nova-?/i, "Nova ")}`;
  return id || "the agent model";
}

// Every figure in a reply must appear in the owner's words or in what the tools returned this turn.
const NUM = /\d[\d,]*(?:\.\d+)?/g;
const norm = (n) => {
  const x = Number(String(n).replace(/,/g, ""));
  return Number.isFinite(x) ? x.toFixed(2) : String(n);
};
function guardFigures(reply, owner, results) {
  const allowed = new Set([...(owner.match(NUM) || []), ...results.flatMap((r) => JSON.stringify(r).match(NUM) || [])].map(norm));
  const said = reply.match(NUM) || [];
  const stray = said.filter((n) => !allowed.has(norm(n)));
  const fallback = results.map((r) => (r.structuredContent?.ok === false ? r.structuredContent.question : r.structuredContent?.speech)).filter(Boolean).join(" ");
  if (!stray.length) {
    $("f-guard").textContent = said.length ? `Passed: ${said.length} figure${said.length === 1 ? "" : "s"}, all from the books` : "Passed: no figures";
    return reply || fallback;
  }
  $("f-guard").textContent = `Replaced: the model said ${stray.join(", ")}, which the books did not`;
  logTraffic("←", "figures check", `replaced ${stray.length}`, "ask");
  return fallback || "I'll only give you figures from your books. Could you ask me that again?";
}

async function turn(text) {
  if (busy || !text.trim()) return;
  if (!modelAvailable()) return guidedTurn(text);
  busy = true;
  els.said.textContent = `“${text}”`;
  els.reply.textContent = "";
  setState("thinking");
  const mark = history.length;
  history.push({ role: "user", content: text });
  const results = [];
  let fallBack = false;
  try {
    for (let round = 0; round < 6; round++) {
      const msg = await askModel();
      const calls = msg.tool_calls || [];
      history.push({ role: "assistant", content: msg.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) {
        say(guardFigures(msg.content || "", text, results));
        break;
      }
      for (const call of calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* the server will ask for what is missing */
        }
        const result = await runTool(call.function.name, args, call.id);
        results.push(result);
        history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.structuredContent ?? result.content) });
      }
    }
  } catch (err) {
    if (err.modelDown && !results.length) {
      // The model gave no answer and no tool has run: the turn is taken back and run as a guided turn instead.
      history = history.slice(0, mark);
      fallBack = true;
      logTraffic("←", "model unavailable", "guided mode", "ask");
    } else {
      setState("idle", "Ready");
      say(`Sorry, that didn't go through: ${String(err.message || err)}`);
      logTraffic("←", "error", "see the reply", "ask");
    }
  } finally {
    history = history.slice(-30);
    while (history.length && history[0].role !== "user") history.shift();
    busy = false;
  }
  if (fallBack) return guidedTurn(text, { modelBusy: true });
}

// ---- voice -----------------------------------------------------------------------------------

function say(text) {
  els.reply.textContent = text;
  speak(text, { listenAfter: lastInputWasVoice && /\?\s*$/.test(text) });
}

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang?.startsWith("en"));
  return voices.find((v) => /Google US English|Samantha|Jenny|Aria/i.test(v.name)) || voices.find((v) => v.lang === "en-US") || voices[0];
}

function speak(text, { listenAfter = false } = {}) {
  if (!settings.voice || !("speechSynthesis" in window)) {
    setState("idle");
    if (listenAfter && lastInputWasVoice) listen();
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\$(\d+)\.(\d\d)\b/g, (_, d, c) => (c === "00" ? `$${d}` : `${d} dollars ${c}`)));
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.03;
  // The screen leaves "Working" at once. A browser with no speech voices never reports the end of speaking,
  // so a timer sized to the sentence sets the screen back to ready either way.
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    if (els.screen.dataset.state === "speaking") setState("idle");
    if (listenAfter && lastInputWasVoice) listen();
  };
  setState("speaking");
  u.onend = done;
  u.onerror = done;
  setTimeout(done, 2500 + text.length * 90);
  speechSynthesis.speak(u);
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer;
function listen() {
  if (!Recognition) {
    els.reply.textContent = "This browser has no speech recognition. Type what you'd say instead.";
    return;
  }
  if (recognizer) return recognizer.stop();
  speechSynthesis.cancel();
  recognizer = new Recognition();
  recognizer.lang = "en-US";
  recognizer.interimResults = true;
  let finalText = "";
  recognizer.onstart = () => {
    setState("listening");
    els.mic.setAttribute("aria-pressed", "true");
  };
  recognizer.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join(" ");
    els.said.textContent = `“${text}”`;
    if (e.results[e.results.length - 1].isFinal) finalText = text;
  };
  recognizer.onerror = () => {};
  recognizer.onend = () => {
    els.mic.setAttribute("aria-pressed", "false");
    recognizer = null;
    if (els.screen.dataset.state === "listening") setState("idle");
    if (!finalText) return;
    lastInputWasVoice = true;
    if (pendingConfirm) return pendingConfirm(heardYes(finalText) ? "accept" : "decline");
    turn(finalText);
  };
  recognizer.start();
}

// ---- wiring ----------------------------------------------------------------------------------

// Each suggestion also names the tool call it stands for, so the page still works with no model at all
// (guided mode): tapping it calls that MCP tool directly and says the tool's own line.
const SUGGESTIONS = [
  { text: "Sold three bread and two cooking oil, cash", tool: "record_sale", args: { items: [{ item: "bread", qty: 3 }, { item: "cooking oil", qty: 2 }], payment: "cash" } },
  { text: "Mai Tendai took two sugar and a bag of maize meal on credit", tool: "record_sale", args: { items: [{ item: "sugar", qty: 2 }, { item: "maize meal", qty: 1 }], payment: "credit", customer: "Mai Tendai" } },
  { text: "Paid five dollars for electricity", tool: "record_expense", args: { amount: 5, category: "electricity", payment: "cash" } },
  { text: "How are we doing today?", tool: "get_day_summary", args: {} },
  { text: "What's running low?", tool: "get_stock", args: {} },
  { text: "Order what's low from Kudzai Wholesale", tool: "reorder_stock", args: { supplier: "Kudzai Wholesale" } },
  { text: "Who owes me money?", tool: "get_customer_tabs", args: {} },
  { text: "Closing up. I counted fifty dollars in the till", tool: "close_day", args: { counted_cash: 50 } },
];

const modelAvailable = () => Boolean(config.model?.relay || settings.llmKey);
const plain = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

async function guidedTurn(text, { modelBusy = false } = {}) {
  const pick = SUGGESTIONS.find((x) => plain(x.text) === plain(text));
  if (!pick) {
    if (modelBusy) $("f-model").textContent = "Busy right now: the suggestions call their tools directly";
    say(modelBusy
      ? "The agent model is busy right now. The suggestions below still work: each one calls its tool directly."
      : "There's no agent model set up here, so I can only run the suggestions below. Add a model under Settings to talk freely.");
    return;
  }
  busy = true;
  els.said.textContent = `“${text}”`;
  els.reply.textContent = "";
  setState("thinking");
  try {
    const out = await runTool(pick.tool, pick.args);
    $("f-model").textContent = modelBusy ? "Busy, so this suggestion called its tool directly" : "None: guided mode calls the tool directly";
    $("f-guard").textContent = "Not needed: the reply is the tool's own line";
    say(out.structuredContent?.ok === false ? out.structuredContent.question : out.structuredContent?.speech || "Done.");
  } catch (err) {
    setState("idle", "Ready");
    say(`Sorry, that didn't go through: ${String(err.message || err)}`);
  } finally {
    busy = false;
  }
}

function fillSettings() {
  $("s-endpoint").value = settings.endpoint;
  $("s-mcp-url").value = settings.mcpUrl || (settings.endpoint === "aws" ? config.aws?.mcpUrl || "" : "");
  $("s-shop").value = settings.shop;
  $("s-aws-user").value = settings.awsUser;
  $("s-aws-pass").value = settings.awsPass;
  $("s-llm-base").value = settings.llmBase;
  $("s-llm-model").value = settings.llmModel;
  $("s-llm-key").value = settings.llmKey;
  $("s-voice").checked = settings.voice;
  $("aws-signin").hidden = settings.endpoint !== "aws";
}

async function main() {
  if (new URLSearchParams(location.search).has("film")) document.body.classList.add("film");
  tickClock();
  setInterval(tickClock, 15_000);
  config = await fetch("config.json").then((r) => r.json()).catch(() => config);
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.text;
    b.onclick = () => {
      lastInputWasVoice = false;
      turn(s.text);
    };
    $("suggest").append(b);
  }
  $("say").onsubmit = (e) => {
    e.preventDefault();
    lastInputWasVoice = false;
    const text = els.input.value;
    els.input.value = "";
    if (pendingConfirm) return pendingConfirm(heardYes(text) ? "accept" : "decline");
    turn(text);
  };
  els.mic.onclick = () => listen();
  $("open-settings").onclick = () => {
    fillSettings();
    $("settings").showModal();
  };
  $("s-endpoint").onchange = () => {
    $("aws-signin").hidden = $("s-endpoint").value !== "aws";
    if ($("s-endpoint").value === "aws" && !$("s-mcp-url").value) $("s-mcp-url").value = config.aws?.mcpUrl || "";
  };
  $("settings").addEventListener("close", async () => {
    if ($("settings").returnValue !== "save") return;
    Object.assign(settings, {
      endpoint: $("s-endpoint").value,
      mcpUrl: $("s-endpoint").value === "local" ? "" : $("s-mcp-url").value.trim(),
      shop: $("s-shop").value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40),
      awsUser: $("s-aws-user").value.trim(),
      awsPass: $("s-aws-pass").value,
      llmBase: $("s-llm-base").value.trim(),
      llmModel: $("s-llm-model").value.trim(),
      llmKey: $("s-llm-key").value.trim(),
      voice: $("s-voice").checked,
    });
    saveSettings();
    history = [];
    await connect().catch(showError);
  });
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};
  if (!modelAvailable()) {
    els.reply.textContent = "No model key? Tap a suggestion: each one calls its MCP tool directly. Add a model under Settings to talk freely.";
    $("f-model").textContent = "None yet: guided mode (add one under Settings)";
  }
  $("toggle-view").onclick = () => {
    const on = document.body.classList.toggle("device");
    scrollTo({ top: 0, behavior: "smooth" });
    $("toggle-view").textContent = on ? "Developer view" : "Device view";
    $("toggle-view").setAttribute("aria-pressed", String(on));
  };
  if (config.hosted) {
    // The hosted copy has no MCP server of its own: it talks to the one on AgentCore, after the judge signs in.
    settings.endpoint = "aws";
    document.querySelector('#s-endpoint option[value="local"]')?.remove();
    $("signin-hint").hidden = false;
    if (!settings.awsUser || !settings.awsPass) {
      fillSettings();
      setState("idle", "Sign in");
      chip("chip-proto", "Sign in to connect", false);
      els.reply.textContent = "Sign in with the judge account from the testing instructions to connect to the server on AWS.";
      $("settings").showModal();
      return;
    }
  }
  await connect().catch(showError);
}

// For recordings and automated checks: plays a spoken request into the page as if the microphone had heard
// it, word by word, then handles it exactly as speech recognition's final result would be handled.
window.imaliHear = async (text, ms = 1500) => {
  lastInputWasVoice = true;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  setState("listening");
  els.mic.setAttribute("aria-pressed", "true");
  const words = text.split(" ");
  for (let i = 1; i <= words.length; i++) {
    els.said.textContent = `“${words.slice(0, i).join(" ")}”`;
    await new Promise((r) => setTimeout(r, ms / words.length));
  }
  els.mic.setAttribute("aria-pressed", "false");
  setState("idle");
  if (pendingConfirm) return pendingConfirm(heardYes(text) ? "accept" : "decline");
  return turn(text);
};
window.imaliBusy = () => busy || els.screen.dataset.state === "thinking";

function showError(err) {
  setState("idle", "Offline");
  chip("chip-proto", "Not connected", false);
  els.reply.textContent = String(err.message || err);
}

main();
