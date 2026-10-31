#!/usr/bin/env bash
# Install Ghidra for REA's native analysis. Safe to re-run.
#
# Cloud: paste `bash scripts/install-ghidra.sh` into the environment's setup
# script (it runs from the repo root). Needs network access to api.github.com,
# github.com, objects.githubusercontent.com and release-assets.githubusercontent.com.
#
# Env overrides: GHIDRA_VERSION (default 12.1.4), GHIDRA_INSTALL_DIR (default /opt/ghidra).
set -euo pipefail

VERSION="${GHIDRA_VERSION:-12.1.4}"
DEST="${GHIDRA_INSTALL_DIR:-/opt/ghidra}"

if [ -x "$DEST/support/analyzeHeadless" ]; then
  echo "Ghidra already installed at $DEST"
  exit 0
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Installing JDK 21"
  apt-get update -qq && apt-get install -y -qq openjdk-21-jdk-headless
fi

api="https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/tags/Ghidra_${VERSION}_build"
url="$(curl -fsSL "$api" | grep -o '"browser_download_url": *"[^"]*\.zip"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
if [ -z "$url" ]; then
  echo "Could not find a Ghidra $VERSION download at $api" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL -o "$tmp/ghidra.zip" "$url"
unzip -q "$tmp/ghidra.zip" -d "$tmp"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mv "$tmp"/ghidra_*_PUBLIC "$DEST"
echo "Ghidra $VERSION installed at $DEST"
