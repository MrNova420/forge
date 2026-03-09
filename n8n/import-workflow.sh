#!/bin/bash
# Import Forge workflow into n8n via API
N8N="http://localhost:5678"
WF="$(dirname $0)/forge-workflow.json"
echo "Importing Forge workflow into n8n..."
curl -s -X POST "$N8N/api/v1/workflows" \
  -H "Content-Type: application/json" \
  -d @"$WF" 2>/dev/null | python3 -m json.tool 2>/dev/null | head -10
echo ""
echo "Done. Visit http://localhost:5678 to activate the workflow."
