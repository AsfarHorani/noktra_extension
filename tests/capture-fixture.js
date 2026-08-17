// One-off dev utility for building fixtures/*.html — NOT part of the test
// suite itself. Renders a real URL with a normal headless Chromium (no
// extension needed here, this is just "save me the rendered HTML"), waits
// for network to settle, and writes the result straight to disk — avoids
// routing potentially large page HTML through anything else. Usage:
//   node capture-fixture.js <url> <fixture-name>
const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");

async function main() {
  const [, , url, name] = process.argv;
  if (!url || !name) {
    console.error("Usage: node capture-fixture.js <url> <fixture-name>");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {
    console.warn("networkidle timed out, using whatever loaded so far");
  });
  const html = await page.content();
  const outPath = path.join(__dirname, "fixtures", `${name}.html`);
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`Saved ${html.length} bytes to ${outPath}`);
  await browser.close();
}

main();
