#!/usr/bin/env sh
# Собирает статический сайт для GitHub Pages: страница + пакет bottlecheck + рецепты.
set -eu
out="${1:-_site}"
rm -rf "$out"
mkdir -p "$out/bottlecheck" "$out/recipes"
cp web/index.html web/app.js web/style.css "$out/"
cp bottlecheck/*.py "$out/bottlecheck/"
cp recipes/*.json "$out/recipes/"
# Версия в ссылках на app.js/style.css, чтобы браузер не держал старую копию из кэша
# (иначе старый список модулей в app.js расходится со свежими .py).
ver="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
sed -i "s|href=\"style.css\"|href=\"style.css?v=$ver\"|; s|src=\"app.js\"|src=\"app.js?v=$ver\"|" "$out/index.html"
touch "$out/.nojekyll"
echo "сайт собран в $out"
