#!/bin/bash
# Forge Auto-Runner v4 — Full Quality Pipeline
# Phases: run → retry-low → scaffold → backup → epic-review → analyze → expand → repeat
FORGE="http://localhost:3737"
PAUSE=6
RETRY_WAIT=20
MAX_TASKS=500
MAX_RETRIES=10
MAX_EXPAND=8
count=0
errors=0
expand_rounds=0
phase="run"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "🔨 Forge Auto-Runner v4 starting (full quality pipeline)..."
log "   API: $FORGE | max tasks: $MAX_TASKS | max expansions: $MAX_EXPAND"
echo ""

if ! curl -s --max-time 5 "$FORGE/health" | grep -q "ok"; then
  log "❌ Forge server not responding. Exiting."
  exit 1
fi

# Get most recent active project
PROJECT_ID=$(curl -s "$FORGE/projects" | python3 -c "
import sys,json
ps=json.load(sys.stdin)
# prefer project with pending tasks
for p in ps:
    if p.get('tasks_pending',0)>0: print(p['id']); exit()
if ps: print(ps[0]['id'])
" 2>/dev/null || echo "")
log "   Active project: ${PROJECT_ID:-none}"
echo ""

# ── Phase 1: Run all pending tasks ──────────────────────────────────────────
while [ $count -lt $MAX_TASKS ]; do
  RESULT=$(curl -s --max-time 1800 -X POST "$FORGE/task/run-next" -H "Content-Type: application/json")
  EXIT_CODE=$?

  if [ $EXIT_CODE -ne 0 ]; then
    errors=$((errors+1))
    log "[net-err] curl failed ($EXIT_CODE) — pause 15s ($errors/$MAX_RETRIES)"
    [ $errors -ge $MAX_RETRIES ] && { log "❌ Too many net errors, exiting."; break; }
    sleep 15; continue
  fi

  if echo "$RESULT" | grep -q "already running"; then
    log "[busy] Pipeline busy — retry in ${RETRY_WAIT}s..."
    sleep $RETRY_WAIT; continue
  fi

  if echo "$RESULT" | grep -q "No pending"; then
    log "⏸  No pending tasks in phase '$phase'"
    break
  fi

  if echo "$RESULT" | grep -q '"error"'; then
    ERR=$(echo "$RESULT" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('error','unknown'))" 2>/dev/null || echo "unknown")
    errors=$((errors+1))
    log "[err] $ERR ($errors/$MAX_RETRIES)"
    [ $errors -ge $MAX_RETRIES ] && { log "❌ Too many errors, exiting."; break; }
    sleep 15; continue
  fi

  TITLE=$(echo "$RESULT" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('title','?')[:60])" 2>/dev/null || echo "?")
  SCORE=$(echo "$RESULT" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('qualityScore','?'))" 2>/dev/null || echo "?")
  FILE=$(echo "$RESULT" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('writtenFile','none') or 'none')" 2>/dev/null || echo "?")
  TESTS=$(echo "$RESULT" | python3 -c "import sys,json; j=json.load(sys.stdin); print('pass' if j.get('testsPassed') else 'fail' if j.get('testsPassed')==False else 'n/a')" 2>/dev/null || echo "?")
  RESP_PID=$(echo "$RESULT" | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('projectId',''))" 2>/dev/null || echo "")
  [ -n "$RESP_PID" ] && PROJECT_ID="$RESP_PID"
  count=$((count+1))
  errors=0
  SCORE_COLOR=""
  [ "$SCORE" -ge 8 ] 2>/dev/null && SCORE_COLOR="✅" || SCORE_COLOR="⚠️"
  log "[$count] $SCORE_COLOR score:${SCORE}/10  tests:${TESTS}  file:${FILE}"
  log "     $TITLE"
  sleep $PAUSE
done

# ── Phase 2: Retry low-quality tasks (score < 7) ────────────────────────────
if [ -n "$PROJECT_ID" ]; then
  log ""
  log "📊 Phase 2: Checking for low-quality tasks to retry..."
  RETRY=$(curl -s -X POST "$FORGE/project/$PROJECT_ID/retry-low-quality" \
    -H "Content-Type: application/json" -d '{"minScore":7}' 2>/dev/null)
  RETRY_COUNT=$(echo "$RETRY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('queued',0))" 2>/dev/null || echo "0")
  if [ "$RETRY_COUNT" -gt "0" ]; then
    log "   ♻️  $RETRY_COUNT tasks reset for retry — running retry phase..."
    RETRY_TASKS=0
    while [ $RETRY_TASKS -lt 50 ]; do
      RESULT=$(curl -s --max-time 1800 -X POST "$FORGE/task/run-next" -H "Content-Type: application/json")
      echo "$RESULT" | grep -q "No pending" && break
      echo "$RESULT" | grep -q "already running" && sleep $RETRY_WAIT && continue
      RSCORE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('qualityScore','?'))" 2>/dev/null || echo "?")
      RTITLE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title','?')[:50])" 2>/dev/null || echo "?")
      RETRY_TASKS=$((RETRY_TASKS+1))
      log "  [retry $RETRY_TASKS] score:${RSCORE}/10 — $RTITLE"
      sleep $PAUSE
    done
    log "   ✅ Retry phase done: $RETRY_TASKS tasks"
  else
    log "   ✅ All tasks meet quality threshold"
  fi

  # ── Phase 3: Scaffold workspace (README, package.json, .gitignore, run.sh) ─
  log ""
  log "📁 Phase 3: Scaffolding project workspace..."
  SCAFFOLD=$(curl -s -X POST "$FORGE/project/$PROJECT_ID/scaffold-workspace" 2>/dev/null)
  CREATED=$(echo "$SCAFFOLD" | python3 -c "import sys,json; print(', '.join(json.load(sys.stdin).get('created',[])))" 2>/dev/null || echo "already exists")
  log "   Files: ${CREATED:-already present}"

  # ── Phase 4: Expand if orchestrator wants more ──────────────────────────────
  while [ $expand_rounds -lt $MAX_EXPAND ]; do
    log ""
    log "🔍 Phase 4/$MAX_EXPAND: Asking orchestrator for more work..."
    EXPAND=$(curl -s --max-time 120 -X POST "$FORGE/project/$PROJECT_ID/expand" \
      -H "Content-Type: application/json" 2>/dev/null)
    ADDED=$(echo "$EXPAND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('added',0))" 2>/dev/null || echo "0")
    COMPLETE=$(echo "$EXPAND" | python3 -c "import sys,json; print(json.load(sys.stdin).get('complete',False))" 2>/dev/null || echo "False")
    if [ "$COMPLETE" = "True" ] || [ "$ADDED" = "0" ]; then
      log "   ✅ Orchestrator: project complete!"
      break
    fi
    TASKS_STR=$(echo "$EXPAND" | python3 -c "import sys,json; j=json.load(sys.stdin); print(', '.join(j.get('tasks',[])))" 2>/dev/null || echo "")
    log "   ➕ Added $ADDED new tasks: $TASKS_STR"
    sleep 3
    expand_rounds=$((expand_rounds+1))
    # Run newly added tasks
    expand_busy=0
    expand_errs=0
    while true; do
      RESULT=$(curl -s --max-time 1800 -X POST "$FORGE/task/run-next" -H "Content-Type: application/json")
      ECURL=$?
      if [ $ECURL -ne 0 ]; then
        expand_errs=$((expand_errs+1))
        log "   [expand-net-err] curl $ECURL ($expand_errs/5)"
        [ $expand_errs -ge 5 ] && { log "   ⚠️ Too many expand errors, moving on"; break; }
        sleep 15; continue
      fi
      [ -z "$RESULT" ] && { expand_errs=$((expand_errs+1)); [ $expand_errs -ge 5 ] && break; sleep 15; continue; }
      echo "$RESULT" | grep -q "No pending" && break
      if echo "$RESULT" | grep -q "already running"; then
        expand_busy=$((expand_busy+1))
        [ $expand_busy -ge 5 ] && { log "   ⚠️ Pipeline busy, moving on"; break; }
        sleep $RETRY_WAIT; continue
      fi
      if echo "$RESULT" | grep -q '"error"'; then
        expand_errs=$((expand_errs+1))
        [ $expand_errs -ge 5 ] && { log "   ⚠️ Too many expand errors, moving on"; break; }
        sleep 15; continue
      fi
      expand_busy=0
      expand_errs=0
      ESCORE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('qualityScore','?'))" 2>/dev/null || echo "?")
      ETITLE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title','?')[:50])" 2>/dev/null || echo "?")
      count=$((count+1))
      log "  [expand-task $count] score:${ESCORE}/10 — $ETITLE"
      sleep $PAUSE
    done
  done

  # ── Phase 5: Final analysis ─────────────────────────────────────────────────
  log ""
  log "🔍 Phase 5: Running final project analysis..."
  ANALYSIS=$(curl -s --max-time 120 -X POST "$FORGE/project/$PROJECT_ID/analyze" \
    -H "Content-Type: application/json" 2>/dev/null)
  AVG=$(echo "$ANALYSIS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('avgScore','?'))" 2>/dev/null || echo "?")
  log "   📊 Final avg quality score: ${AVG}/10"

  # ── Phase 6: Backup ─────────────────────────────────────────────────────────
  log ""
  log "📦 Phase 6: Creating project backup..."
  BACKUP=$(curl -s -X POST "$FORGE/project/$PROJECT_ID/backup" 2>/dev/null)
  BSIZE=$(echo "$BACKUP" | python3 -c "import sys,json; print(round(json.load(sys.stdin).get('size',0)/1024))" 2>/dev/null || echo "?")
  log "   Backup: ${BSIZE}KB"
fi

# ── Final summary ────────────────────────────────────────────────────────────
echo ""
log "=== FINAL STATS ==="
curl -s "$FORGE/stats" | python3 -c "
import sys,json
s=json.load(sys.stdin)
t=s['tasks']
print(f\"  Projects: {s['projects']}\")
print(f\"  Tasks: {t['total']} total | {t['done']} done | {t['pending']} pending\")
print(f\"  Avg quality: {s['avgQualityScore']}/10\")
" 2>/dev/null
echo ""
log "🏁 Forge Auto-Runner v4 complete. $count tasks processed."
