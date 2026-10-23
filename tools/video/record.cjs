// Records the demo film from the running simulator, with live MCP calls and live model calls.
// Each owner line is played into the page as speech (window.imaliHear); each reply is waited for, read off
// the screen and kept, so narrate.py can voice exactly what the page said.
//   APP=https://imali-ai-alexa-plus.vercel.app FILM_AWS_USER=... FILM_AWS_PASS=... node tools/video/record.cjs
// The hosted page talks to the MCP servers on AgentCore once signed in; a local page does with FILM_ENDPOINT=aws.
// Writes submission/work/film-raw.mp4, film-raw.events.json and replies.json. Needs playwright-core and Chrome.
const fs = require("fs");
const path = require("path");
const { record, hand } = require("./capture.cjs");

const APP = (process.env.APP || "http://127.0.0.1:8787").replace(/\/$/, "");
const ROOT = path.resolve(__dirname, "..", "..");
const WORK = path.join(ROOT, "submission", "work");
const SCRIPT = require("./script.json");
const LENGTHS = JSON.parse(fs.readFileSync(path.join(WORK, "takes", "lengths.json"), "utf8"));
const SHOP = process.env.FILM_SHOP || `rudo-${Date.now().toString(36)}`;
const GAP = 0.4;
// The assistant's voice read 10.9 characters a second at Murf's default rate (measured 23 Oct 2026); at rate 8
// it is a little quicker. The real take replaces this estimate when the film is mixed.
const estimate = (text) => text.length / 11.8 + 0.4;

const END_CARD = `(() => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;background:#f3f0ee;opacity:0;transition:opacity .9s cubic-bezier(.22,1,.36,1);font-family:'Sofia Sans',system-ui,sans-serif;color:#141413";
  d.innerHTML = \`<div style="width:1040px">
    <p style="margin:0;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#696969"><i style="width:9px;height:9px;border-radius:50%;background:#cf4500;display:inline-block"></i>Amazon Developer Hackathon · Alexa+ track</p>
    <p style="margin:18px 0 0;font-size:88px;font-weight:500;letter-spacing:-.035em;line-height:.98">Imali AI for Alexa+</p>
    <p style="margin:14px 0 0;font-size:30px;font-weight:450;color:#262627">A shop's books, kept by voice, on an open MCP server.</p>
    <div style="margin:38px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div style="background:#fcfbfa;border-radius:24px;padding:20px 22px;font-size:19px;line-height:1.45"><b style="display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#cf4500;margin-bottom:6px">Built</b>Two MCP servers, spec 2025-11-25, Streamable HTTP<br>A supplier's quote, then the owner's yes (elicitation)<br>MCP Apps cards · books kept across sessions</div>
      <div style="background:#fcfbfa;border-radius:24px;padding:20px 22px;font-size:19px;line-height:1.45"><b style="display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#cf4500;margin-bottom:6px">On AWS</b>Amazon Bedrock AgentCore Runtime, two runtimes<br>Amazon Cognito sign-in<br>Amazon DynamoDB for the books</div>
    </div>
    <p style="margin:30px 0 0;font-size:21px">Try it: <b>imali-ai-alexa-plus.vercel.app</b> · Code (MIT): <b>gitlab.com/ebenworks-systems/imali-ai-alexa-plus</b></p>
    <p style="margin:22px 0 0;font-size:16px;color:#696969">An Ebenworks product. The shop, people and figures are invented, and the voices are synthesized. Replies and timings are live.</p>
  </div>\`;
  document.body.append(d);
  requestAnimationFrame(() => requestAnimationFrame(() => (d.style.opacity = "1")));
})()`;

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const replies = [];
  const settings = { shop: SHOP, voice: false, endpoint: process.env.FILM_ENDPOINT || "local", awsUser: process.env.FILM_AWS_USER || "", awsPass: process.env.FILM_AWS_PASS || "" };
  const result = await record({
    name: "film-raw",
    outDir: WORK,
    viewport: { width: 1280, height: 720 },
    scale: 1.5,
    fingers: true,
    init: [`try { localStorage.setItem("imali-ai-alexa-settings", ${JSON.stringify(JSON.stringify(settings))}); } catch {}`],
    start: `${APP}/?film`,
    setup: async ({ page }) => {
      await page.waitForFunction(() => document.getElementById("chip-proto").textContent.includes("2025-11-25"), null, { timeout: 20000 });
      await page.waitForSelector("#cards iframe", { timeout: 10000 });
      await page.waitForTimeout(1500);
    },
    script: async ({ page, mark, sleep }) => {
      const h = hand(page);
      let n = 0;
      let voiceUntil = 0; // when a narrator line that runs over the next action will end
      const t0 = Date.now();
      const now = () => (Date.now() - t0) / 1000;
      const quiet = async () => { const left = voiceUntil - now(); if (left > 0) await sleep(left * 1000 + 150); };
      const idle = async () => {
        await page.waitForFunction(() => !window.imaliBusy() && document.getElementById("reply").textContent.length > 0, null, { timeout: 90000, polling: 150 });
      };
      for (const scene of SCRIPT.scenes) {
        mark(`scene:${scene.id}`);
        for (const beat of scene.beats) {
          if (beat.owner) {
            await quiet();
            const len = LENGTHS[beat.owner];
            mark(`owner:${beat.owner}`);
            await page.evaluate(([t, ms]) => { window.imaliHear(t, ms); }, [beat.say, Math.max(500, len * 1000 - 150)]);
            await sleep(len * 1000 + 250);
          } else if (beat.assistant === "ask") {
            await page.waitForSelector("#confirm:not([hidden])", { timeout: 90000 });
            await sleep(500);
            await quiet(); // a narrator line over the wait finishes before the assistant speaks
            const text = `${await page.textContent("#confirm-q")} Shall I go ahead?`;
            const id = `a-${++n}`;
            mark(`assistant:${id}`);
            replies.push({ id, text });
            await sleep((estimate(text) + GAP) * 1000);
          } else if (beat.assistant) {
            await idle();
            await sleep(350);
            await quiet();
            const text = await page.textContent("#reply");
            const id = `a-${++n}`;
            mark(`assistant:${id}`);
            replies.push({ id, text });
            await sleep((estimate(text) + GAP) * 1000);
          } else if (beat.narrator) {
            await quiet();
            mark(`narrator:${beat.narrator}`);
            if (beat.overlap) voiceUntil = now() + LENGTHS[beat.narrator] + GAP;
            else await sleep((LENGTHS[beat.narrator] + GAP) * 1000);
          } else if (beat.action === "hood-on") {
            await page.evaluate(() => document.querySelector(".hood").classList.add("lit"));
            await h.point(".traffic li:first-child", { scroll: false });
          } else if (beat.action === "trace") {
            // Light the log and open the books server's own call to the supplier's place_order.
            await page.evaluate(() => {
              document.querySelector(".hood").classList.add("lit");
              document.getElementById("traffic").scrollTop = 0;
              const d = document.querySelector("#traffic li.nested details");
              if (d) d.open = true;
            });
            await h.point("#traffic li.nested", { scroll: false });
          } else if (beat.action === "device") {
            await h.click("#toggle-view");
            await sleep(900);
          } else if (beat.action === "hood-off") {
            await page.evaluate(() => document.querySelector(".hood").classList.remove("lit"));
          } else if (beat.action === "reload") {
            await page.reload();
            await page.waitForFunction(() => document.getElementById("chip-proto").textContent.includes("2025-11-25"), null, { timeout: 20000 });
            await page.waitForSelector("#cards iframe", { timeout: 10000 });
            await sleep(900);
          } else if (beat.action === "aws") {
            await h.click("#open-settings");
            await sleep(500);
            await page.selectOption("#s-endpoint", "aws");
            await page.dispatchEvent("#s-endpoint", "change");
            await sleep(700);
            await h.click("#s-save");
            await page.waitForFunction(() => document.getElementById("chip-endpoint").textContent.includes("AWS") && document.getElementById("chip-proto").textContent.includes("2025-11-25"), null, { timeout: 40000 });
            await page.waitForSelector("#cards iframe", { timeout: 20000 });
            await sleep(900);
          } else if (beat.action === "end-card") {
            await quiet();
            await page.evaluate(END_CARD);
            await sleep(1200);
          }
        }
        await sleep(300);
      }
      await sleep(1500);
    },
  });
  fs.writeFileSync(path.join(WORK, "replies.json"), JSON.stringify(replies, null, 1));
  console.log(`${result.out}: ${result.seconds.toFixed(1)} s, ${replies.length} replies`);
  for (const r of replies) console.log(`  ${r.id}  ${r.text}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
