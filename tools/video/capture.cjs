// Records a scripted browser session as crisp frames, straight from the page's own screencast.
// (The browser's built-in video recorder keeps only CSS-pixel size; this keeps device pixels, so a phone
// at 2x or a laptop at 1.5x stays sharp.) Used by record.cjs. Needs playwright-core and a Chromium.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PLAYWRIGHT = process.env.PLAYWRIGHT_CORE || "playwright-core";
const CHROME = process.env.CHROME_BIN || undefined;
const { chromium } = require(PLAYWRIGHT);

// The screencast sends a picture only when the page repaints, and a pure opacity or transform animation can run
// without repainting, so a tiny element is repainted 30 times a second to keep every frame of the film.
const HEARTBEAT = `(() => {
  const beat = () => {
    const e = document.createElement("i");
    e.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;pointer-events:none;z-index:2147483646;";
    document.documentElement.append(e);
    let on = false;
    setInterval(() => { on = !on; e.style.background = on ? "rgba(247,241,232,.01)" : "rgba(247,241,232,.02)"; }, 33);
  };
  if (document.documentElement) beat(); else addEventListener("DOMContentLoaded", beat);
})();`;

const CURSOR = `(() => {
  const make = () => {
    if (document.getElementById("__finger")) return;
    const c = document.createElement("div");
    c.id = "__finger";
    c.style.cssText = "position:fixed;z-index:2147483647;left:-50px;top:-50px;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:rgba(255,255,255,.55);border:2px solid rgba(28,27,26,.6);box-shadow:0 4px 14px rgba(28,27,26,.25);pointer-events:none;transition:transform .12s ease,background .2s ease;";
    document.documentElement.append(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { c.style.transform = "scale(.72)"; c.style.background = "rgba(42,114,222,.4)"; }, true);
    addEventListener("mouseup", () => { c.style.transform = ""; c.style.background = "rgba(255,255,255,.55)"; }, true);
  };
  if (document.documentElement) make(); else addEventListener("DOMContentLoaded", make);
})();`;

/** Opens a browser, runs `script(ctx)` while capturing, and writes <out>.mp4 at 30 fps. */
async function record({ name, outDir, viewport, scale = 1, mobile = false, fingers = true, script, setup, start = "about:blank", init = [] }) {
  const dir = path.join(outDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile, reducedMotion: "no-preference", acceptDownloads: true });
  await context.addInitScript(HEARTBEAT);
  if (fingers) await context.addInitScript(CURSOR);
  for (const s of init) await context.addInitScript(s);
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  const frames = [];
  const events = [];
  let n = 0;
  let t0 = null;
  client.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `f${String(n++).padStart(6, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    if (t0 === null) t0 = metadata.timestamp;
    frames.push({ file, t: metadata.timestamp - t0 });
    client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  const W = Math.round(viewport.width * scale), H = Math.round(viewport.height * scale);
  await page.goto(start);
  if (setup) await setup({ page, context });
  await client.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const wall0 = Date.now();
  let wallEnd = 0;
  const mark = (label) => { events.push({ label, t: (Date.now() - wall0) / 1000 }); };
  try {
    const at = async (t) => { const d = t * 1000 - (Date.now() - wall0); if (d > 0) await page.waitForTimeout(d); };
    await script({ page, context, client, mark, at, sleep: (ms) => page.waitForTimeout(ms) });
  } finally {
    await page.waitForTimeout(400);
    wallEnd = (Date.now() - wall0) / 1000;
    await client.send("Page.stopScreencast").catch(() => {});
  }
  await context.close();
  await browser.close();
  // frames -> constant 30 fps video. The wall clock of the first frame is time zero.
  const list = [];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(wallEnd, f.t + 0.4);
    list.push(`file '${f.file}'`, `duration ${Math.max(next - f.t, 0.001).toFixed(4)}`);
  });
  list.push(`file '${frames[frames.length - 1].file}'`);
  const listFile = path.join(dir, "frames.txt");
  fs.writeFileSync(listFile, list.join("\n"));
  const out = path.join(outDir, `${name}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `fps=30,scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-movflags", "+faststart", out]);
  const total = Math.max(wallEnd, frames.length ? frames[frames.length - 1].t + 0.4 : 0);
  fs.writeFileSync(path.join(outDir, `${name}.events.json`), JSON.stringify({ name, frames: frames.length, seconds: +total.toFixed(2), width: W, height: H, events }, null, 1));
  // the frames are only needed to build the video
  for (const f of frames) fs.rmSync(f.file, { force: true });
  return { out, seconds: total, width: W, height: H, events };
}

/** A pointer that moves like a hand: eased steps, a short pause, then the click or tap. */
function hand(page) {
  let x = 200, y = 200;
  const ease = (t) => t * t * (3 - 2 * t);
  async function moveTo(tx, ty, ms = 600) {
    const steps = Math.max(8, Math.round(ms / 16));
    const sx = x, sy = y;
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      await page.mouse.move(sx + (tx - sx) * k, sy + (ty - sy) * k);
      await page.waitForTimeout(ms / steps);
    }
    x = tx; y = ty;
  }
  async function point(selector, { dx = 0, dy = 0, ms = 650, scroll = true } = {}) {
    const loc = page.locator(selector).first();
    if (scroll) await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    await moveTo(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, ms);
    return b;
  }
  async function click(selector, opts = {}) {
    await point(selector, opts);
    await page.waitForTimeout(120);
    await page.mouse.down();
    await page.waitForTimeout(90);
    await page.mouse.up();
  }
  async function type(selector, text, perChar = 55, opts = {}) {
    await click(selector, opts);
    for (const ch of text) { await page.keyboard.type(ch); await page.waitForTimeout(perChar + Math.random() * 25); }
  }
  async function scrollTo(y, ms = 900) {
    await page.evaluate(([top, dur]) => new Promise((resolve) => {
      const from = scrollY, t0 = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur), e = k * k * (3 - 2 * k);
        scrollTo(0, from + (top - from) * e);
        k < 1 ? requestAnimationFrame(step) : resolve();
      };
      requestAnimationFrame(step);
    }), [y, ms]);
  }
  // Smooth-scroll the page so an element sits `offset` px below the top of the screen.
  async function scrollToEl(selector, { offset = 16, ms = 900 } = {}) {
    const top = await page.evaluate(([sel, off]) => document.querySelector(sel).getBoundingClientRect().top + scrollY - off, [selector, offset]);
    await scrollTo(Math.max(0, top), ms);
  }
  // Smooth-scroll the inside of a scrolling element (the plan panel on a laptop).
  async function scrollEl(selector, top, ms = 900) {
    await page.evaluate(([sel, to, dur]) => new Promise((resolve) => {
      const el = document.querySelector(sel), from = el.scrollTop, t0 = performance.now();
      const step = (now) => { const k = Math.min(1, (now - t0) / dur), e = k * k * (3 - 2 * k); el.scrollTop = from + (to - from) * e; k < 1 ? requestAnimationFrame(step) : resolve(); };
      requestAnimationFrame(step);
    }), [selector, top, ms]);
  }
  return { moveTo, point, click, type, scrollTo, scrollToEl, scrollEl };
}

module.exports = { record, hand };
