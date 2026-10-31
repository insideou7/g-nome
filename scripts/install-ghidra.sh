#!/usr/bin/env bash
# Install Ghidra for REA's native analysis. Safe to re-run.
#
# Cloud: paste `bash scripts/install-ghidra.sh` into the environment's setup
# script (it runs from the repo root). Needs network access to github.com,
# objects.githubusercontent.com and release-assets.githubusercontent.com.
#
# Env override: GHIDRA_INSTALL_DIR (default /opt/ghidra).
# To change version, update the three values below from the GitHub release page.
set -euo pipefail

VERSION="12.1.4"
BUILD_DATE="20260921"
SHA256="ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db"
DEST="${GHIDRA_INSTALL_DIR:-/opt/ghidra}"

if [ -x "$DEST/support/analyzeHeadless" ]; then
  echo "Ghidra already installed at $DEST"
  exit 0
fi

if ! command -v java >/dev/null 2>&1; then
  echo "Installing JDK 21"
  apt-get update -qq && apt-get install -y -qq openjdk-21-jdk-headless
fi

url="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${VERSION}_build/ghidra_${VERSION}_PUBLIC_${BUILD_DATE}.zip"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $url"
curl -fsSL -o "$tmp/ghidra.zip" "$url"
echo "$SHA256  $tmp/ghidra.zip" | sha256sum -c -
unzip -q "$tmp/ghidra.zip" -d "$tmp"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mv "$tmp"/ghidra_*_PUBLIC "$DEST"
echo "Ghidra $VERSION installed at $DEST"
