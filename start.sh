#!/bin/bash
# Forge Manual Start Script
cd /home/mrnova420/forge

if curl -s http://localhost:3737/health > /dev/null 2>&1; then
  echo "⚡ Forge is already running at http://localhost:3737"
  exit 0
fi

mkdir -p logs
nohup node src/server.js >> logs/forge.log 2>&1 &
FORGE_PID=$!
disown $FORGE_PID
echo $FORGE_PID > /tmp/forge.pid

sleep 2
if curl -s http://localhost:3737/health > /dev/null 2>&1; then
  echo "✅ Forge started (PID: $FORGE_PID) at http://localhost:3737"
else
  echo "❌ Forge failed to start — check logs/forge.log"
fi
