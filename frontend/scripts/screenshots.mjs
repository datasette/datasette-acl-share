// Programmatic doc screenshots of the share dialog.
//
// Drives the *already-running* `just dev` demo (port 5171) with Playwright —
// it does NOT start datasette itself. Run `just dev` in one terminal, then
// `just shots` in another. Output → docs/screenshots/*.png (committed; the
// README embeds them, so re-run + commit when the dialog's look changes).
//
// Each case targets one instance on the single /sample-resources page, picked
// for the sharing shape it shows. Only an actor who can manage an instance can
// open its dialog, so each case names the right actor. debug-gotham
// authenticates off a plain `actor` cookie, so "log in as X" is just a cookie.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const BASE = process.env.SHOTS_BASE || "http://localhost:5171";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/screenshots");

// Each case picks an instance by (resource-type, parent) — the attributes on its
// <datasette-acl-share-dialog> element — plus the actor who can manage it.
const CASES = [
  // sparse roster (one owner + one public audience)
  { name: "empty", type: "channel", parent: "announcements", actor: "clark" },
  // named-people roster (project is people-only: Maintainer + Contributor + Reader)
  { name: "people", type: "project", parent: "apollo", actor: "clark" },
  // a group grant on the roster (daily-planet Editor)
  { name: "groups", type: "playlist", parent: "summer-mix", actor: "clark" },
  // general access: a public audience (everyone) Viewer
  { name: "public", type: "paste", parent: "kryptonite-notes", actor: "clark" },
  // interactive sub-states, driven against a people-only instance so search has
  // people to surface (anyone already shared is filtered out of results):
  { name: "people-search", type: "project", parent: "apollo", actor: "clark", search: "j" },
  // a person picked → staged as a pill with role + Add button, BEFORE sharing
  { name: "people-selected", type: "project", parent: "apollo", actor: "clark", search: "j", pick: true },
  // unified picker: one search surfacing both People and Groups (channel has
  // the groups feature; "p" matches Alfred Pennyworth + the daily-planet group,
  // one row each so both sub-sections fit inside the dialog box).
  { name: "search-unified", type: "channel", parent: "newsroom-chat", actor: "clark", search: "p", waitFor: ".datasette-acl-share-dialog__result >> text=Alfred Pennyworth" },
];

// Every instance on the page renders its own <dialog>; only the one we opened
// carries the [open] attribute, so scope to it (others match the class too).
const DIALOG = "dialog.datasette-acl-share-dialog[open]";

// Optional CLI filter: `node screenshots.mjs people-selected groups` regenerates
// only the named cases, so iterating on one shot doesn't rewrite (and re-stat)
// every PNG. No args → all cases.
const only = new Set(process.argv.slice(2));
const cases = only.size ? CASES.filter((c) => only.has(c.name)) : CASES;
if (only.size && cases.length !== only.size) {
  const known = new Set(CASES.map((c) => c.name));
  const bad = [...only].filter((n) => !known.has(n));
  throw new Error(`Unknown screenshot case(s): ${bad.join(", ")}`);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();

for (const c of cases) {
  const ctx = await browser.newContext({ deviceScaleFactor: 2 });
  await ctx.addCookies([
    { name: "actor", value: c.actor, url: BASE },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sample-resources`);
  const el = `datasette-acl-share-dialog[resource-type="${c.type}"][parent="${c.parent}"]`;
  await page.click(`${el} .datasette-acl-share__trigger`);
  await page.waitForSelector(`${DIALOG} .datasette-acl-share-dialog__list`);

  if (c.search) {
    await page.fill(".datasette-acl-share-dialog__search", c.search);
    // Wait for a real result row, not the (immediate) empty-state container —
    // the search is debounced + async.
    await page.waitForSelector(".datasette-acl-share-dialog__result");
    // Groups filter synchronously but people search is debounced/async, so a
    // unified shot can fire before the people rows land. `waitFor` lets a case
    // block until a known late-arriving row is present.
    if (c.waitFor) await page.waitForSelector(c.waitFor);
  }
  if (c.pick) {
    // Click the first result to stage that person as a removable pill, then
    // wait for the pill (with its role <select> + Add button) to render.
    await page.click(".datasette-acl-share-dialog__result");
    await page.waitForSelector(".datasette-acl-share-dialog__pill");
    // Dismiss the (still-open) results dropdown so the shot cleanly shows the
    // staged pill + role + Add — the "selected, before confirming" state.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#datasette-acl-share-results", { state: "detached" });
  }

  const file = resolve(OUT, `${c.name}.png`);
  await page.locator(DIALOG).screenshot({ path: file });
  console.log(`✓ ${c.name} → ${file}`);
  await ctx.close();
}

await browser.close();
