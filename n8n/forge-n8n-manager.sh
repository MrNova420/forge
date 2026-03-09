#!/bin/bash
# Forge N8n workflow manager
N8N_URL="${N8N_URL:-http://localhost:5678}"
ACTION="${1:-status}"

case "$ACTION" in
  export)
    echo "Exporting n8n workflows..."
    curl -s "$N8N_URL/api/v1/workflows" -H "Accept: application/json" > ~/forge/n8n/workflows-backup-$(date +%Y%m%d).json 2>/dev/null && echo "✓ Exported" || echo "✗ n8n not running or API not available"
    ;;
  import)
    FILE="${2:-~/forge/n8n/master-workflow.json}"
    echo "Importing workflow from $FILE..."
    curl -s -X POST "$N8N_URL/api/v1/workflows" \
      -H "Content-Type: application/json" \
      -d @"$FILE" 2>/dev/null && echo "✓ Imported" || echo "✗ Import failed (n8n may need Basic Auth)"
    ;;
  status)
    echo "N8n status:"
    curl -s "$N8N_URL/healthz" 2>/dev/null && echo "" || echo "✗ n8n not responding at $N8N_URL"
    echo "Forge workflows in ~/forge/n8n/:"
    ls ~/forge/n8n/*.json 2>/dev/null | xargs -I{} basename {}
    ;;
  test)
    echo "Testing Forge webhook..."
    curl -s -X POST "$N8N_URL/webhook/forge" -H "Content-Type: application/json" -d '{"type":"test","message":"hello"}' 2>/dev/null || echo "Webhook not active (activate in n8n UI first)"
    ;;
esac
