#!/usr/bin/env bash
# Lints the workflows in the current directory with a checksum-pinned actionlint release (Linux x64 runners).
set -euo pipefail
dir=$(mktemp -d)
curl -fsSL -o "$dir/actionlint.tar.gz" https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz
echo "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8  $dir/actionlint.tar.gz" | sha256sum --check
tar -xzf "$dir/actionlint.tar.gz" -C "$dir" actionlint
"$dir/actionlint"
