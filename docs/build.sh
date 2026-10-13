#!/usr/bin/env bash
# Build the docs site for GitHub Pages: docs/*.md → _site/, served at
# https://anzaui.github.io/rust/ (every URL under /rust/).
#
# Needs the anza CLI (ANZA, default `anza`) and the anza repo's web/src theme
# in .anza/ (see [assets] in docs/config.toml). `anza docs` writes a site for
# the domain root (theme assets at /styles, /tokens, …; home page in docs/),
# so this script moves everything under one folder and prefixes the
# site-root URLs with the base path.
set -euo pipefail

cd "$(dirname "$0")/.."
ANZA="${ANZA:-anza}"
BASE=/rust
RAW=_site.raw
OUT=_site

"$ANZA" docs --config docs/config.toml --out "$RAW"

rm -rf "$OUT"
mv "$RAW${BASE}" "$OUT"
mv "$RAW/docs/index.html" "$OUT/index.html"
mv "$RAW/styles" "$RAW/tokens" "$RAW/views" "$RAW/docks" "$RAW/app.js" "$RAW/view-code.js" "$OUT/"
cp logo.svg "$OUT/favicon.svg"
rm -rf "$RAW"
# anza 0.6.0 routes a section's index.md to <section>/index: serve it at <section>/.
find "$OUT" -mindepth 2 -type d -name index -not -path "$OUT/docks/*" -not -path "$OUT/views/*" |
  while read -r dir; do mv "$dir/index.html" "$dir/../index.html"; rm -rf "$dir"; done
# Page-module stubs (unused by the static site).
find "$OUT" -path "$OUT/docks" -prune -o -path "$OUT/views" -prune -o -name index.js -type f -print0 | xargs -0 rm -f

# Site-root URLs → base path; sidebar links to section pages drop `/index`.
# The page-module stubs are not published, so app.js stops importing them.
find "$OUT" -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' \) -print0 |
  xargs -0 sed -i -E \
    -e "s#([\"'(])/(tokens|styles|docks|views|app\.js|favicon\.svg)#\1${BASE}/\2#g" \
    -e "s#href=\"/(docs)?\"#href=\"${BASE}/\"#g" \
    -e "s#(href=\"${BASE}/[^\"]*)/index\"#\1\"#g" \
    -e '/rel="alternate icon"/d'
sed -i -E \
  -e "/^import '\.\/docs\/index\.js';/d" \
  -e "s#'/docs/index\.html'#'${BASE}/index.html'#" \
  -e "s#'/docs'#'${BASE}'#g" \
  "$OUT/app.js"

echo "docs → $OUT/ (base ${BASE}/)"
