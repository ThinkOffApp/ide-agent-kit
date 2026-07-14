#!/usr/bin/env bash
# Point this clone's git hooks at the committed .githooks/ dir so the
# pre-commit secret scanner runs. Run once after cloning.
set -euo pipefail
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "core.hooksPath -> .githooks (pre-commit secret scan active)"
