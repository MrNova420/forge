#!/bin/bash
set -e
echo "⚡ Installing Forge VS Code Extension..."
cd "$(dirname "$0")"
npm install --silent
npm run compile
if command -v vsce &>/dev/null; then
  vsce package --no-dependencies
  echo "✅ Package built: forge-ai-1.0.0.vsix"
  echo "Install in VS Code: Extensions > ... > Install from VSIX"
else
  echo "ℹ To package: npm install -g @vscode/vsce && vsce package"
  echo "Or load unpacked: VS Code > Extensions > ... > Install from VSIX (after compiling)"
fi
echo "📁 Extension dir: $(pwd)"
echo "In VS Code: Ctrl+Shift+P > 'Extensions: Install from VSIX' and pick forge-ai-1.0.0.vsix"
