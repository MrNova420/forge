// Cross-session memory persistence
// Stores agent learnings, best practices, error patterns in a flat JSON file
// so they persist across server restarts and long dev sessions
const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '../db/session-memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {}
  return { bestPractices: [], errorPatterns: {}, projectSummaries: {}, agentLearnings: {}, createdAt: new Date().toISOString() };
}

function saveMemory(mem) {
  try {
    const tmp = MEMORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mem, null, 2));
    fs.renameSync(tmp, MEMORY_FILE);
  } catch {}
}

let _mem = loadMemory();

// Record a best practice (what works well)
function recordBestPractice(text, role = 'general') {
  if (!text || _mem.bestPractices.some(p => p.text === text)) return;
  _mem.bestPractices.push({ text, role, score: 1, usedAt: new Date().toISOString() });
  if (_mem.bestPractices.length > 100) _mem.bestPractices = _mem.bestPractices.slice(-100);
  saveMemory(_mem);
}

// Record an error pattern (what fails repeatedly)
function recordErrorPattern(pattern, context = '') {
  if (!pattern) return;
  const key = pattern.slice(0, 80);
  _mem.errorPatterns[key] = (_mem.errorPatterns[key] || 0) + 1;
  saveMemory(_mem);
}

// Get top error patterns
function getTopErrors(n = 10) {
  return Object.entries(_mem.errorPatterns).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([p,c])=>({pattern:p,count:c}));
}

// Store a project context summary (for rolling memory)
function setProjectSummary(projectId, summary) {
  _mem.projectSummaries[projectId] = { summary, updatedAt: new Date().toISOString() };
  saveMemory(_mem);
}

function getProjectSummary(projectId) {
  return _mem.projectSummaries[projectId]?.summary || null;
}

// Record what an agent learned from a task
function recordAgentLearning(role, learning, score) {
  if (!_mem.agentLearnings[role]) _mem.agentLearnings[role] = [];
  _mem.agentLearnings[role].push({ learning, score, ts: Date.now() });
  // Keep only top 20 per role sorted by score
  _mem.agentLearnings[role] = _mem.agentLearnings[role]
    .sort((a,b) => b.score - a.score).slice(0, 20);
  saveMemory(_mem);
}

// Get best practices for a role as formatted prompt context
function getBestPracticesContext(role = 'general') {
  const practices = _mem.bestPractices.filter(p => p.role === role || p.role === 'general').slice(-5);
  if (!practices.length) return '';
  return `TEAM BEST PRACTICES:\n${practices.map(p=>`- ${p.text}`).join('\n')}\n\n`;
}

// Get error avoidance context
function getErrorAvoidanceContext() {
  const topErrors = getTopErrors(5);
  if (!topErrors.length) return '';
  return `KNOWN ISSUES TO AVOID:\n${topErrors.map(e=>`- ${e.pattern} (seen ${e.count}x)`).join('\n')}\n\n`;
}

function getAllMemory() { return { ..._mem, topErrors: getTopErrors() }; }
function resetMemory() { _mem = { bestPractices: [], errorPatterns: {}, projectSummaries: {}, agentLearnings: {}, createdAt: new Date().toISOString() }; saveMemory(_mem); }

module.exports = {
  recordBestPractice, recordErrorPattern, getTopErrors,
  setProjectSummary, getProjectSummary,
  recordAgentLearning, getBestPracticesContext, getErrorAvoidanceContext,
  getAllMemory, resetMemory
};
