// Takes the gallery pictures from the running simulator, with live calls: 2700 x 1800 (3:2), light theme.
//   APP=http://127.0.0.1:8787 GALLERY_AWS_USER=... GALLERY_AWS_PASS=... node tools/gallery.cjs
// Writes submission/gallery/*.jpg (ignored by git).
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_CORE || "playwright-core");

const APP = (process.env.APP || "http://127.0.0.1:8787").replace(/\/$/, "");
const OUT = path.resolve(__dirname, "..", "submission", "gallery");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
  const ctx = await browser.newContext({ viewport: { width: 1350, height: 900 }, deviceScaleFactor: 2 });
  const settings = { shop: `gallery-${Date.now().toString(36)}`, voice: false, awsUser: process.env.GALLERY_AWS_USER || "", awsPass: process.env.GALLERY_AWS_PASS || "" };
  await ctx.addInitScript(`try { localStorage.setItem("imali-ai-alexa-settings", ${JSON.stringify(JSON.stringify(settings))}); } catch {}`);
  const page = await ctx.newPage();
  const shot = async (name) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: "jpeg", quality: 90 });
    console.log(name);
  };
  const ready = () => page.waitForFunction(() => !window.imaliBusy() && document.getElementById("reply").textContent.length > 0, null, { timeout: 90000 });
  const hear = async (text) => {
    await page.evaluate((t) => { window.imaliHear(t, 800); }, text);
    await page.waitForTimeout(1200);
  };

  await page.goto(`${APP}/?film`);
  await page.waitForFunction(() => document.getElementById("chip-proto").textContent.includes("2025-11-25"), null, { timeout: 20000 });
  await page.waitForSelector("#cards iframe");
  await page.evaluate(() => { document.getElementById("reply").textContent = "Try “Order what's low from Kudzai Wholesale.”"; });
  await shot("03-stock-carousel");

  await hear("Sold three bread and two cooking oil, cash");
  await ready();
  await shot("01-sale-by-voice");

  await hear("Mai Tendai took two sugar and a bag of maize meal on credit");
  await ready();
  await hear("Order what's low from Kudzai Wholesale");
  await page.waitForSelector("#confirm:not([hidden])", { timeout: 90000 });
  await shot("02-confirm-purchase-elicitation");
  await page.click("#confirm-yes");
  await ready();
  await shot("04-purchase-order-confirmed");

  await hear("Closing up. I counted fifty dollars in the till");
  await ready();
  await shot("05-close-the-day");

  if (settings.awsUser) {
    await page.click("#open-settings");
    await page.selectOption("#s-endpoint", "aws");
    await page.dispatchEvent("#s-endpoint", "change");
    await page.click("#s-save");
    await page.waitForFunction(() => document.getElementById("chip-endpoint").textContent.includes("AWS") && document.getElementById("chip-proto").textContent.includes("2025-11-25"), null, { timeout: 40000 });
    await page.waitForSelector("#cards iframe");
    await hear("Who owes me money?");
    await ready();
    await shot("06-on-aws-agentcore");
  }
  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
