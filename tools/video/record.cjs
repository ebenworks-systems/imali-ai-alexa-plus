// Records the demo film from the running simulator, with live MCP calls and live model calls.
// Each owner line is played into the page as speech (window.imaliHear); each reply is waited for, read off
// the screen and kept, so narrate.py can voice exactly what the page said.
//   APP=http://127.0.0.1:8787 FILM_AWS_USER=... FILM_AWS_PASS=... node tools/video/record.cjs
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
// The assistant's voice reads about 14 characters a second; the real take replaces this estimate later.
const estimate = (text) => text.length / 14 + 0.5;

const END_CARD = `(() => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;background:#f3f0ee;opacity:0;transition:opacity .9s cubic-bezier(.22,1,.36,1);font-family:'Sofia Sans',system-ui,sans-serif;color:#141413";
  d.innerHTML = \`<div style="width:1040px">
    <p style="margin:0;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#696969"><i style="width:9px;height:9px;border-radius:50%;background:#cf4500;display:inline-block"></i>Amazon Developer Hackathon · Alexa+ track</p>
    <p style="margin:18px 0 0;font-size:88px;font-weight:500;letter-spacing:-.035em;line-height:.98">Imali AI for Alexa+</p>
    <p style="margin:14px 0 0;font-size:30px;font-weight:450;color:#262627">A shop's books, kept by voice, on an open MCP server.</p>
    <div style="margin:38px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div style="background:#fcfbfa;border-radius:24px;padding:20px 22px;font-size:19px;line-height:1.45"><b style="display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#cf4500;margin-bottom:6px">Built</b>MCP server, spec 2025-11-25, Streamable HTTP<br>MCP Apps cards · elicitation before a purchase<br>Books kept per shop across sessions</div>
      <div style="background:#fcfbfa;border-radius:24px;padding:20px 22px;font-size:19px;line-height:1.45"><b style="display:block;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#cf4500;margin-bottom:6px">On AWS</b>Amazon Bedrock AgentCore Runtime<br>Amazon Cognito sign-in<br>Amazon DynamoDB for the books</div>
    </div>
    <p style="margin:30px 0 0;font-size:21px">Code (MIT): <b>gitlab.com/ebenworks-systems/imali-ai-alexa-plus</b></p>
    <p style="margin:22px 0 0;font-size:16px;color:#696969">An Ebenworks product. The shop, people and figures are invented, and the voices are synthesized. Replies and timings are live.</p>
  </div>\`;
  document.body.append(d);
  requestAnimationFrame(() => requestAnimationFrame(() => (d.style.opacity = "1")));
})()`;

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const replies = [];
  const settings = { shop: SHOP, voice: false, awsUser: process.env.FILM_AWS_USER || "", awsPass: process.env.FILM_AWS_PASS || "" };
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
      const idle = async () => {
        await page.waitForFunction(() => !window.imaliBusy() && document.getElementById("reply").textContent.length > 0, null, { timeout: 90000, polling: 150 });
      };
      for (const scene of SCRIPT.scenes) {
        mark(`scene:${scene.id}`);
        for (const beat of scene.beats) {
          if (beat.owner) {
            const len = LENGTHS[beat.owner];
            mark(`owner:${beat.owner}`);
            await page.evaluate(([t, ms]) => { window.imaliHear(t, ms); }, [beat.say, Math.max(500, len * 1000 - 150)]);
            await sleep(len * 1000 + 250);
          } else if (beat.assistant === "ask") {
            await page.waitForSelector("#confirm:not([hidden])", { timeout: 90000 });
            await sleep(500);
            const text = `${await page.textContent("#confirm-q")} Shall I go ahead?`;
            const id = `a-${++n}`;
            mark(`assistant:${id}`);
            replies.push({ id, text });
            await sleep((estimate(text) + GAP) * 1000);
          } else if (beat.assistant) {
            await idle();
            await sleep(350);
            const text = await page.textContent("#reply");
            const id = `a-${++n}`;
            mark(`assistant:${id}`);
            replies.push({ id, text });
            await sleep((estimate(text) + GAP) * 1000);
          } else if (beat.narrator) {
            mark(`narrator:${beat.narrator}`);
            await sleep((LENGTHS[beat.narrator] + GAP) * 1000);
          } else if (beat.action === "hood-on") {
            await page.evaluate(() => document.querySelector(".hood").classList.add("lit"));
            await h.point(".traffic li:first-child", { scroll: false });
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
