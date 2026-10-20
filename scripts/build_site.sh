#!/usr/bin/env sh
# Собирает статический сайт для GitHub Pages: страница + пакет bottlecheck + рецепты.
set -eu
out="${1:-_site}"
rm -rf "$out"
mkdir -p "$out/bottlecheck" "$out/recipes"
cp web/index.html web/app.js web/style.css "$out/"
cp bottlecheck/*.py "$out/bottlecheck/"
cp recipes/*.json "$out/recipes/"
touch "$out/.nojekyll"
echo "сайт собран в $out"
