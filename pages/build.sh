#!/usr/bin/env bash
set -euo pipefail

pages_dir="$(cd "$(dirname "$0")" && pwd)"
app_root="$(dirname "$pages_dir")"
output="$pages_dir/dist"

mkdir -p "$output"
cp "$app_root/index.html" "$output/"
for directory in assets css js; do
  rm -rf "${output:?}/$directory"
  cp -R "$app_root/$directory" "$output/$directory"
done
cp "$pages_dir/_worker.js" "$output/_worker.js"
echo "Pages build ready: $output"
