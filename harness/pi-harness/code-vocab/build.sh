#!/usr/bin/env bash
# build.sh -- run ctags then make_vocab.py (bash equivalent of build.ps1).
#   $1  MODE             default "grand"
#   $2  ATLAS_BUDGET     default 2000
#   $3  TOKENS_PER_FILE  default 80
# Env: ROOT (default .), SCOPE, CTAGS (override binary), VOCAB_OUT, TAGS_OUT.
set -euo pipefail

MODE="${1:-grand}"
ATLAS_BUDGET="${2:-2000}"
TOKENS_PER_FILE="${3:-80}"
ROOT="${ROOT:-.}"
# Artifacts live under <root>/.pi/code-vocab/ (matches the auto-wiring extension).
TAGS_OUT="${TAGS_OUT:-.pi/code-vocab/tags.json}"
VOCAB_OUT="${VOCAB_OUT:-.pi/code-vocab/vocabulary.md}"

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_PATH="$(cd "$ROOT" && pwd)"
TAGS_PATH="$ROOT_PATH/$TAGS_OUT"
VOCAB_PATH="$ROOT_PATH/$VOCAB_OUT"
mkdir -p "$(dirname "$TAGS_PATH")"

# Resolve ctags: $CTAGS, else bundled, else PATH.
if [ -z "${CTAGS:-}" ]; then
  if [ -x "$PKG_DIR/bin/ctags.exe" ]; then CTAGS="$PKG_DIR/bin/ctags.exe"
  elif [ -x "$PKG_DIR/bin/ctags" ]; then CTAGS="$PKG_DIR/bin/ctags"
  elif command -v ctags >/dev/null 2>&1; then CTAGS="ctags"
  else echo "ctags not found (bundled bin/ missing and not on PATH)." >&2; exit 1
  fi
fi

rm -f "$TAGS_PATH"
echo "ctags: $CTAGS"
# Run ctags from inside the repo root with `.` so tag paths are RELATIVE
# (e.g. agent/extensions/foo.ts), not absolute C:/Users/... — the atlas buckets
# by path segments and absolute paths collapse into one root bucket.
( cd "$ROOT_PATH" && "$CTAGS" \
  --recurse \
  --output-format=json \
  --fields=+nKzS \
  --languages=Python,JavaScript,TypeScript,Go,Rust,Java,Kotlin,Ruby,C,C++,C#,PHP,Lua \
  --links=no \
  --exclude=.git --exclude=.pi --exclude=node_modules --exclude=.venv \
  --exclude=venv --exclude=dist --exclude=build \
  --exclude=target --exclude=__pycache__ \
  --exclude='*.egg-info' --exclude='*.min.js' --exclude='*.log' \
  --exclude=package-lock.json --exclude=yarn.lock \
  --exclude=pnpm-lock.yaml --exclude='*.bundle.js' \
  -f "$TAGS_OUT" . )

[ -f "$TAGS_PATH" ] || { echo "ctags produced no tags.json" >&2; exit 1; }

ARGS=(--root "$ROOT_PATH" --tags "$TAGS_PATH" --mode "$MODE"
      --out "$VOCAB_PATH" --tokens-per-file "$TOKENS_PER_FILE"
      --atlas-budget "$ATLAS_BUDGET")
[ -n "${SCOPE:-}" ] && ARGS+=(--scope "$SCOPE")
python "$PKG_DIR/make_vocab.py" "${ARGS[@]}"

echo "tags.json:     $TAGS_PATH ($(wc -c < "$TAGS_PATH") bytes)"
echo "vocabulary.md: $VOCAB_PATH ($(wc -c < "$VOCAB_PATH") bytes)"
