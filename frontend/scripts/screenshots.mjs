// Programmatic doc screenshots of the share dialog.
//
// Drives the *already-running* `just dev` demo (port 5171) with Playwright —
// it does NOT start datasette itself. Run `just dev` in one terminal, then
// `just shots` in another. Output → docs/screenshots/*.png (committed; the
// README embeds them, so re-run + commit when the dialog's look changes).
//
// Each case is (doc id + its owner): the demo seeds a different sharing shape
// per doc and only the owner can open the dialog. debug-gotham authenticates
// off a plain `actor` cookie, so "log in as X" is just a cookie.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const BASE = process.env.SHOTS_BASE || "http://localhost:5171";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/screenshots");

const CASES = [
  { name: "empty", doc: "1", actor: "clark" }, // owner-only roster
  { name: "people", doc: "7", actor: "clark" }, // named-person roster (clark + lois)
  { name: "groups", doc: "6", actor: "lois" }, // both newsroom group grants
  { name: "public", doc: "8", actor: "jimmy" }, // general access: authenticated Viewer
  // interactive sub-states (doc 1 = only Clark on the roster, so search has
  // people to surface — anyone already shared is filtered out of results):
  { name: "people-search", doc: "1", actor: "clark", search: "l" }, // people dropdown open
  { name: "groups-tab", doc: "1", actor: "clark", tab: "Groups" }, // groups picker tab
];

const DIALOG = "dialog.datasette-acl-share-dialog";

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const c of CASES) {
  const ctx = await browser.newContext({ deviceScaleFactor: 2 });
  await ctx.addCookies([
    { name: "actor", value: c.actor, url: BASE },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sample-docs/${c.doc}`);
  await page.click(".datasette-acl-share__trigger");
  await page.waitForSelector(`${DIALOG} .datasette-acl-share-dialog__list`);

  if (c.tab) {
    await page.click(`.datasette-acl-share-dialog__tab >> text=${c.tab}`);
  }
  if (c.search) {
    await page.fill(".datasette-acl-share-dialog__search", c.search);
    // Wait for a real result row, not the (immediate) empty-state container —
    // the search is debounced + async.
    await page.waitForSelector(".datasette-acl-share-dialog__result");
  }

  const file = resolve(OUT, `${c.name}.png`);
  await page.locator(DIALOG).screenshot({ path: file });
  console.log(`✓ ${c.name} → ${file}`);
  await ctx.close();
}

await browser.close();
