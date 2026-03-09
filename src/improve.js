// Self-improvement engine
// Watches quality scores, detects failure patterns, evolves system prompts
const { generate } = require('./ollama');
const { memoryManager } = require('./memory');
const Database = require('better-sqlite3');
const path = require('path');

const PROJ_DB = () => new Database(path.join(__dirname, '../db/project.db'));
const MEM_DB  = () => new Database(path.join(__dirname, '../db/agent_memory.db'));
const PRM_DB  = () => new Database(path.join(__dirname, '../db/prompts.db'));

// ── Quality Trend Analyzer ───────────────────────────────────────────────────

function getQualityTrend(agentRole, lastN = 20) {
  const db = MEM_DB();
  const scores = db.prepare(
    `SELECT score, timestamp FROM reflection_scores WHERE agent=? ORDER BY timestamp DESC LIMIT ?`
  ).all(agentRole, lastN);
  db.close();
  if (scores.length < 2) return { trend: 'insufficient_data', scores: [] };
  const avg = scores.reduce((s, r) => s + r.score, 0) / scores.length;
  const recent = scores.slice(0, 5).reduce((s, r) => s + r.score, 0) / Math.min(5, scores.length);
  const older  = scores.slice(-5).reduce((s, r) => s + r.score, 0) / Math.min(5, scores.length);
  return {
    trend: recent > older + 0.5 ? 'improving' : recent < older - 0.5 ? 'declining' : 'stable',
    avgScore: avg.toFixed(2),
    recentAvg: recent.toFixed(2),
    scores: scores.map(s => s.score)
  };
}

// ── Failure Pattern Detector ─────────────────────────────────────────────────

function detectFailurePatterns(agentRole) {
  const db = MEM_DB();
  const patterns = db.prepare(
    `SELECT pattern, frequency FROM error_patterns WHERE agent=? ORDER BY frequency DESC LIMIT 10`
  ).all(agentRole);
  db.close();

  const taskDb = PROJ_DB();
  const failedTasks = taskDb.prepare(
    `SELECT title, description FROM tasks WHERE quality_score < 6 AND assigned_agent=? ORDER BY updated_at DESC LIMIT 10`
  ).all(agentRole);
  taskDb.close();

  return { errorPatterns: patterns, failedTasks };
}

// ── Prompt Evolution ─────────────────────────────────────────────────────────

async function evolvePrompt(agentRole, currentPrompt) {
  const { errorPatterns, failedTasks } = detectFailurePatterns(agentRole);
  const trend = getQualityTrend(agentRole);

  if (errorPatterns.length === 0 && failedTasks.length === 0) {
    return { evolved: false, reason: 'No failure patterns found — prompt is performing well' };
  }

  const patternText = errorPatterns.map(p => `- "${p.pattern}" (seen ${p.frequency}x)`).join('\n');
  const taskText = failedTasks.map(t => `- ${t.title}`).join('\n');

  const improvedPrompt = await generate(
    `You are improving a system prompt for an AI agent.

AGENT ROLE: ${agentRole}
QUALITY TREND: ${trend.trend} (avg score: ${trend.avgScore}/10, recent: ${trend.recentAvg}/10)

CURRENT SYSTEM PROMPT:
${currentPrompt}

RECURRING ERRORS THIS AGENT MAKES:
${patternText || 'None recorded'}

RECENTLY FAILED TASKS:
${taskText || 'None recorded'}

Rewrite the system prompt to:
1. Explicitly warn against the recurring errors above
2. Add specific instructions to prevent these failure patterns
3. Keep the core role and expertise intact
4. Make it more effective overall

Output ONLY the improved system prompt, no explanation:`,
    { temperature: 0.3 }
  );

  // Save new version to prompts.db
  const db = PRM_DB();
  const lastVersion = db.prepare(
    `SELECT MAX(version) as v FROM prompt_versions WHERE agent=?`
  ).get(agentRole);
  const newVersion = (lastVersion?.v || 0) + 1;

  // Mark old prompts inactive
  db.prepare(`UPDATE prompt_versions SET active=0 WHERE agent=?`).run(agentRole);
  db.prepare(
    `INSERT INTO prompt_versions (agent, version, system_prompt, active) VALUES (?,?,?,1)`
  ).run(agentRole, newVersion, improvedPrompt.text);
  db.close();

  return {
    evolved: true,
    version: newVersion,
    newPrompt: improvedPrompt.text,
    basedOnErrors: errorPatterns.length,
    trend
  };
}

// ── A/B Test Runner ───────────────────────────────────────────────────────────

async function runABTest(agentRole, promptA, promptB, testTask) {
  const { multipass } = require('./multipass');

  const [resultA, resultB] = await Promise.all([
    multipass(testTask, promptA, { rounds: 2, minScore: 5 }),
    multipass(testTask, promptB, { rounds: 2, minScore: 5 })
  ]);

  const winner = resultA.score >= resultB.score ? 'A' : 'B';
  const db = PRM_DB();
  db.prepare(`INSERT INTO ab_tests (agent, a_score, b_score) VALUES (?,?,?)`)
    .run(agentRole, resultA.score, resultB.score);
  db.close();

  return {
    winner,
    scoreA: resultA.score,
    scoreB: resultB.score,
    delta: Math.abs(resultA.score - resultB.score),
    winningPrompt: winner === 'A' ? promptA : promptB
  };
}

// ── Full Improvement Cycle ────────────────────────────────────────────────────

async function runImprovementCycle(agents) {
  const results = {};
  for (const [role, prompt] of Object.entries(agents)) {
    const trend = getQualityTrend(role);
    console.log(`[improve] ${role}: trend=${trend.trend} avg=${trend.avgScore}`);

    // Only evolve if declining or avg < 7
    if (trend.trend === 'declining' || (parseFloat(trend.avgScore) < 7 && trend.avgScore !== 'NaN')) {
      console.log(`[improve] Evolving prompt for ${role}...`);
      results[role] = await evolvePrompt(role, prompt);
    } else {
      results[role] = { evolved: false, reason: `Score ${trend.avgScore} — no evolution needed` };
    }
  }
  return results;
}

// ── Dashboard Stats ───────────────────────────────────────────────────────────

function getDashboard() {
  const memDb = MEM_DB();
  const projDb = PROJ_DB();
  const prmDb = PRM_DB();

  const agentScores = memDb.prepare(
    `SELECT agent, AVG(score) as avg, COUNT(*) as runs, MAX(score) as best FROM reflection_scores GROUP BY agent`
  ).all();

  const taskStats = projDb.prepare(
    `SELECT status, COUNT(*) as n, AVG(quality_score) as avg_quality FROM tasks GROUP BY status`
  ).all();

  const promptVersions = prmDb.prepare(
    `SELECT agent, MAX(version) as latest, COUNT(*) as total_versions FROM prompt_versions GROUP BY agent`
  ).all();

  const topErrors = memDb.prepare(
    `SELECT agent, pattern, frequency FROM error_patterns ORDER BY frequency DESC LIMIT 10`
  ).all();

  memDb.close(); projDb.close(); prmDb.close();

  return {
    agents: agentScores.map(a => ({
      role: a.agent,
      avgScore: a.avg?.toFixed(2) || 'N/A',
      runs: a.runs,
      bestScore: a.best,
      trend: getQualityTrend(a.agent).trend
    })),
    tasks: taskStats,
    prompts: promptVersions,
    topErrors,
    timestamp: new Date().toISOString()
  };
}

module.exports = { evolvePrompt, runABTest, runImprovementCycle, getQualityTrend, detectFailurePatterns, getDashboard };
