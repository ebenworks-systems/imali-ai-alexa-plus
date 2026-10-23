// The simulated Alexa+ experience. This page is a real MCP client (the official TypeScript SDK, bundled):
// it initializes over Streamable HTTP, lists the server's tools, hands them to an agent model, calls the
// tools the model picks, answers the server's elicitation requests, and hosts the server's MCP Apps views.
// The model chooses tools and words; every figure it may say must already be in the books' answers.

import { Client, ElicitRequestSchema, StreamableHTTPClientTransport } from "./vendor/mcp.js";

const $ = (id) => document.getElementById(id);
const els = { screen: $("screen"), said: $("said"), reply: $("reply"), cards: $("cards"), state: $("state"), clock: $("clock"), traffic: $("traffic"), mic: $("mic"), input: $("say-input") };
const APP_MIME = "text/html;profile=mcp-app";
const UI_PROTOCOL = "2026-01-26";
const SETTINGS_KEY = "imali-ai-alexa-settings";

const settings = { endpoint: "local", mcpUrl: "", shop: "", awsUser: "", awsPass: "", llmBase: "", llmModel: "", llmKey: "", voice: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
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
const uiCache = new Map();

// ---- small helpers ---------------------------------------------------------------------------

function setState(state, label) {
  els.screen.dataset.state = state;
  els.state.textContent = label ?? { idle: "Ready", listening: "Listening", thinking: "Working", speaking: "Speaking" }[state] ?? "";
}

function logTraffic(dir, text, note = "", cls = "") {
  const li = document.createElement("li");
  li.className = `${dir === "←" ? "in" : "out"} ${cls}`.trim();
  li.innerHTML = `<span class="dir">${dir}</span><code></code><small></small>`;
  li.querySelector("code").textContent = text;
  li.querySelector("small").textContent = note;
  els.traffic.prepend(li);
  while (els.traffic.children.length > 60) els.traffic.lastChild.remove();
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
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  return data.AuthenticationResult.AccessToken;
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

  // Log every JSON-RPC message this page sends and receives.
  const started = new Map();
  const send = transport.send.bind(transport);
  transport.send = async (msg, opts) => {
    if (msg.method) {
      started.set(msg.id, performance.now());
      const what = msg.method === "tools/call" ? `tools/call ${msg.params.name}` : msg.method === "resources/read" ? `resources/read ${msg.params.uri}` : msg.method;
      if (msg.method !== "notifications/initialized") logTraffic("→", what);
    } else if (msg.result) logTraffic("→", "elicitation answer", msg.result.action, "ask");
    return send(msg, opts);
  };
  const t0 = performance.now();
  await client.connect(transport);
  const onmessage = transport.onmessage;
  transport.onmessage = (msg, extra) => {
    if (msg.method === "elicitation/create") logTraffic("←", "elicitation/create", "server asks the owner", "ask");
    else if (msg.id !== undefined && started.has(msg.id)) {
      const ms = Math.round(performance.now() - started.get(msg.id));
      started.delete(msg.id);
      logTraffic("←", msg.error ? `error ${msg.error.code}` : "result", `${ms} ms`);
    }
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
    speak(`${params.message} Shall I go ahead?`, { listenAfter: true });
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

async function runTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  await showCard(name, args, result).catch((err) => logTraffic("←", "view failed", String(err.message || err)));
  return result;
}

// ---- the agent model ------------------------------------------------------------------------

function systemPrompt() {
  return `You are Imali AI, speaking through a voice assistant on a small shop's counter (a simulated Alexa+ experience). The owner talks to you while serving customers.

${instructions}

Speak like a calm, quick shop assistant. When a tool's "speech" line answers the owner, say that line as it is; you may add a few words but no figure of your own. If the owner's words are unclear, ask one short question. Today's date in the shop: ${new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(new Date())}.`;
}

function modelHeaders() {
  const h = { "content-type": "application/json" };
  if (settings.llmKey) {
    h["x-llm-key"] = settings.llmKey;
    if (settings.llmBase) h["x-llm-base-url"] = settings.llmBase;
    if (settings.llmModel) h["x-llm-model"] = settings.llmModel;
  }
  return h;
}

async function askModel() {
  const t0 = performance.now();
  const res = await fetch("agent/chat", { method: "POST", headers: modelHeaders(), body: JSON.stringify({ messages: [{ role: "system", content: systemPrompt() }, ...history], tools: modelTools }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `The model relay answered ${res.status}`);
  const label = settings.llmKey ? `${settings.llmModel || "your model"} (your endpoint)` : `${data.model}${data.provider ? ` · Njere ${data.provider}` : ""}`;
  $("f-model").textContent = `${label} · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  return data.message;
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
  busy = true;
  els.said.textContent = `“${text}”`;
  els.reply.textContent = "";
  setState("thinking");
  history.push({ role: "user", content: text });
  const results = [];
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
        const result = await runTool(call.function.name, args);
        results.push(result);
        history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.structuredContent ?? result.content) });
      }
    }
  } catch (err) {
    say(String(err.message || err));
    logTraffic("←", "error", String(err.message || err).slice(0, 60));
  } finally {
    history = history.slice(-30);
    while (history.length && history[0].role !== "user") history.shift();
    busy = false;
  }
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
  u.onstart = () => setState("speaking");
  u.onend = () => {
    setState("idle");
    if (listenAfter && lastInputWasVoice) listen();
  };
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
    if (pendingConfirm) return pendingConfirm(/\b(yes|yeah|yep|sure|confirm|go ahead|okay|ok)\b/i.test(finalText) ? "accept" : "decline");
    turn(finalText);
  };
  recognizer.start();
}

// ---- wiring ----------------------------------------------------------------------------------

const SUGGESTIONS = [
  "Sold three bread and two cooking oil, cash",
  "Mai Tendai took two sugar and a bag of maize meal on credit",
  "Paid five dollars for electricity",
  "How are we doing today?",
  "What's running low?",
  "Order what's low from Kudzai Wholesale",
  "Who owes me money?",
  "Closing up. I counted fifty dollars in the till",
];

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
  tickClock();
  setInterval(tickClock, 15_000);
  config = await fetch("config.json").then((r) => r.json()).catch(() => config);
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    b.onclick = () => {
      lastInputWasVoice = false;
      turn(s);
    };
    $("suggest").append(b);
  }
  $("say").onsubmit = (e) => {
    e.preventDefault();
    lastInputWasVoice = false;
    const text = els.input.value;
    els.input.value = "";
    if (pendingConfirm) return pendingConfirm(/\b(yes|yeah|confirm|ok)\b/i.test(text) ? "accept" : "decline");
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
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    history = [];
    await connect().catch(showError);
  });
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};
  if (!config.model?.relay && !settings.llmKey) els.reply.textContent = "Add an OpenAI-compatible model endpoint and key in Settings to talk to the agent. The MCP server is already connected.";
  await connect().catch(showError);
}

function showError(err) {
  setState("idle", "Offline");
  chip("chip-proto", "Not connected", false);
  els.reply.textContent = String(err.message || err);
}

main();
