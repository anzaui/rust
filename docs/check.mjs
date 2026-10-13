#!/usr/bin/env node
/**
 * docs/check.mjs — browser smoke test for a built static docs site.
 *
 * Serves the site under BASE (the GitHub Pages sub-path), loads every page
 * listed in the sidebar in headless Chrome and fails on: JavaScript errors,
 * failed or 4xx/5xx requests, a loader still visible after load, a page
 * without a content heading, in-page links to missing pages, or a sidebar
 * click that doesn't load the target page.
 *
 * Usage:
 *   node docs/check.mjs <site dir> <base> [--links=<selector>] [--heading=<selector>]
 *   e.g. node docs/check.mjs _site /rust
 *
 * Defaults fit mdBook: --links='.sidebar .chapter a' --heading='main h1'
 * (or LINKS_SELECTOR / HEADING_SELECTOR in the environment).
 * Needs puppeteer-core (PUPPETEER_CORE = path to its ESM entry) and Chrome
 * (CHROME_PATH, default /usr/bin/google-chrome).
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i < 0 ? [a.slice(2), 'true'] : [a.slice(2, i), a.slice(i + 1)];
    }),
);
const [siteDir = '_site', rawBase = ''] = positional;
const base = rawBase.replace(/\/+$/, '');
const LINKS = flags.links || process.env.LINKS_SELECTOR || '.sidebar .chapter a';
const HEADING = flags.heading || process.env.HEADING_SELECTOR || 'main h1';

if (!process.env.PUPPETEER_CORE) {
  console.error('docs check: set PUPPETEER_CORE to the puppeteer-core ESM entry');
  process.exit(2);
}
const puppeteer = (await import(pathToFileURL(process.env.PUPPETEER_CORE).href)).default;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};

// Static server that behaves like GitHub Pages under a sub-path.
const root = resolve(siteDir);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(base + '/') && url.pathname !== base) return res.writeHead(404).end();
  const rel = decodeURIComponent(url.pathname.slice(base.length)) || '/';
  let file = normalize(join(root, rel));
  if (!file.startsWith(root)) return res.writeHead(404).end();
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!rel.endsWith('/')) return res.writeHead(301, { location: url.pathname + '/' }).end();
    file = join(file, 'index.html');
  }
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const home = origin + base + '/';
const inSite = (href) => href && href.startsWith(home);
const strip = (href) => href.split('#')[0];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
const problems = [];
const report = (where, issues) => problems.push(...issues.map((i) => `${where.slice(origin.length)}: ${i}`));

function watch(page, issues) {
  page.on('pageerror', (e) => issues.push(`JS error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && issues.push(`console error: ${m.text()}`));
  page.on('requestfailed', (r) => issues.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => r.status() >= 400 && issues.push(`HTTP ${r.status()}: ${r.url()}`));
}

async function inspect(page) {
  return page.evaluate(
    (LINKS, HEADING) => {
      const visible = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
      };
      const heading = document.querySelector(HEADING);
      return {
        heading: heading?.textContent?.trim(),
        loaders: [...document.querySelectorAll('[class*="loading" i],[aria-busy="true"],ui-spinner')].filter(visible).length,
        links: [...document.querySelectorAll(LINKS)].map((a) => a.href),
        content: [...document.querySelectorAll('main a[href]')].map((a) => a.href),
      };
    },
    LINKS,
    HEADING,
  );
}

async function visit(url) {
  const page = await browser.newPage();
  const issues = [];
  watch(page, issues);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 300));
  const state = await inspect(page);
  if (!state.heading) issues.push(`no heading (${HEADING})`);
  if (state.loaders) issues.push(`${state.loaders} loader(s) still visible`);
  return { page, issues, state };
}

// 1. Landing page: sidebar links.
const first = await visit(home);
const links = [...new Set(first.state.links.filter(inSite).map(strip))];
if (!links.length) first.issues.push(`no sidebar links (${LINKS})`);

// 2. Navigation: click a sidebar entry for another page and expect it to load.
const target = links.find((h) => h !== home && h !== home + 'index.html');
if (target) {
  const before = first.state.heading;
  const rel = target.slice(home.length);
  const clicked = await first.page.evaluate(
    (LINKS, rel) => {
      const a = [...document.querySelectorAll(LINKS)].find((el) => el.getAttribute('href') === rel || el.href.endsWith('/' + rel));
      a?.click();
      return !!a;
    },
    LINKS,
    rel,
  );
  if (!clicked) first.issues.push(`could not click the sidebar link to ${rel}`);
  else {
    await first.page.waitForFunction((u) => location.href.split('#')[0] === u, { timeout: 10000 }, target).catch(() => {});
    await first.page.waitForNetworkIdle({ idleTime: 300, timeout: 10000 }).catch(() => {});
    const after = (await inspect(first.page)).heading;
    if (!after || after === before) first.issues.push(`clicking ${rel} did not load a new page (heading: ${after ?? 'none'})`);
  }
}
report(home, first.issues);
await first.page.close();

// 3. Full load of every sidebar page; collect in-content links.
const contentLinks = new Map();
for (const href of links) {
  const { page, issues, state } = await visit(href);
  for (const c of state.content.filter(inSite)) if (!contentLinks.has(strip(c))) contentLinks.set(strip(c), href);
  report(href, issues);
  await page.close();
}

// 4. In-content links must point at pages that exist.
for (const [href, from] of contentLinks) {
  const res = await fetch(href);
  if (!res.ok) problems.push(`${from.slice(origin.length)}: link to ${href.slice(origin.length)} is HTTP ${res.status}`);
}

await browser.close();
server.close();
if (problems.length) {
  console.error(`docs check: ${problems.length} problem(s)\n` + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log(`docs check: ok (${links.length} pages, ${contentLinks.size} content links, sidebar navigation works)`);
