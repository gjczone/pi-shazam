#!/data/data/com.termux/files/usr/bin/sh
set -e

echo "=== Installing pi-shazam for Termux/Android ARM64 ==="
AGENT_NPM="${HOME}/.pi/agent/npm"
mkdir -p "$AGENT_NPM"

cd "$AGENT_NPM"
CXXFLAGS="-std=c++20" npm install "https://github.com/sasazemzulin058-debug/pi-shazam.git#fix/termux-lsp-safe-path-dirs" --force --legacy-peer-deps

echo "✅ pi-shazam successfully installed"
