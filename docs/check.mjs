#!/usr/bin/env node
/**
 * docs/check.mjs — browser smoke test for the built docs site.
 *
 * Serves _site under BASE (the GitHub Pages sub-path), loads every page in
 * headless Chrome and fails on: JavaScript errors, failed or 4xx/5xx requests,
 * a loader still visible after load, a missing <h1>, or a soft navigation
 * (sidebar click) that doesn't render the target page.
 *
 * Usage: node docs/check.mjs <site dir> <base>     e.g. node docs/check.mjs _site /rust
 * Needs: puppeteer-core (PUPPETEER_CORE=path to its ESM entry) and Chrome
 * (CHROME_PATH, default /usr/bin/google-chrome).
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const [siteDir = '_site', base = ''] = process.argv.slice(2);
const puppeteer = (await import(pathToFileURL(process.env.PUPPETEER_CORE).href)).default;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml' };

// Static server that behaves like GitHub Pages under a sub-path.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(base + '/') && url.pathname !== base) return res.writeHead(404).end();
  let rel = decodeURIComponent(url.pathname.slice(base.length)) || '/';
  let file = normalize(join(siteDir, rel));
  if (!file.startsWith(normalize(siteDir))) return res.writeHead(404).end();
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!rel.endsWith('/')) return res.writeHead(301, { location: url.pathname + '/' }).end();
    file = join(file, 'index.html');
  }
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const problems = [];

async function visit(path) {
  const page = await browser.newPage();
  const issues = [];
  page.on('pageerror', (e) => issues.push(`JS error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && issues.push(`console error: ${m.text()}`));
  page.on('requestfailed', (r) => issues.push(`request failed: ${r.url()}`));
  page.on('response', (r) => r.status() >= 400 && issues.push(`HTTP ${r.status()}: ${r.url()}`));
  await page.goto(origin + path, { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 500));
  const state = await page.evaluate(() => {
    const visible = (el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
    };
    return {
      h1: document.querySelector('h1')?.textContent?.trim(),
      loaders: [...document.querySelectorAll('[class*="loading" i],[aria-busy="true"],ui-spinner')].filter(visible).length,
      links: [...document.querySelectorAll('.sidebar-nav a')].map((a) => a.getAttribute('href')),
    };
  });
  if (!state.h1) issues.push('no <h1> rendered');
  if (state.loaders) issues.push(`${state.loaders} loader(s) still visible`);
  return { page, issues, state };
}

const first = await visit(base + '/');
const links = [...new Set(first.state.links)].filter((h) => h && h.startsWith(base + '/'));
if (!links.length) first.issues.push('no sidebar links');
problems.push(...first.issues.map((i) => `${base}/: ${i}`));

// Soft navigation from the home page to the second sidebar entry.
if (links[1]) {
  const href = links[1];
  const before = first.state.h1;
  await first.page.click(`.sidebar-nav a[href="${href}"]`);
  await new Promise((r) => setTimeout(r, 1000));
  const after = await first.page.evaluate(() => document.querySelector('h1')?.textContent?.trim());
  if (!after || after === before) problems.push(`soft navigation to ${href} did not render a new page`);
}
await first.page.close();

// Hard load of every page in the sidebar.
for (const href of links) {
  const { page, issues } = await visit(href);
  problems.push(...issues.map((i) => `${href}: ${i}`));
  await page.close();
}

await browser.close();
server.close();
if (problems.length) {
  console.error(`docs check: ${problems.length} problem(s)\n` + problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}
console.log(`docs check: ok (${links.length + 1} pages, soft navigation works)`);
