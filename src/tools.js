// Tools layer — gives agents real-world capabilities
// file I/O, shell exec, git, test runner, package manager
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const PROJECTS_DIR = path.join(__dirname, '../projects');

// ── File Tools ───────────────────────────────────────────────────────────────

function readFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: `File not found: ${abs}` };
  return { ok: true, content: fs.readFileSync(abs, 'utf8'), path: abs };
}

function guardProjectPath(filePath, projectId) {
  const projectBase = path.resolve(path.join(__dirname, '../projects', projectId));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(projectBase)) {
    throw new Error(`Path traversal blocked: ${filePath} is outside project dir`);
  }
  return resolved;
}

function writeFile(filePath, content, projectId) {
  const abs = projectId ? guardProjectPath(filePath, projectId) : path.resolve(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { ok: true, path: abs, bytes: Buffer.byteLength(content) };
}

function listFiles(dirPath, extensions = []) {
  const abs = path.resolve(dirPath);
  if (!fs.existsSync(abs)) return { ok: false, error: `Dir not found: ${abs}` };
  const walk = (dir) => {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(f => {
      const full = path.join(dir, f.name);
      if (f.isDirectory() && !['node_modules','.git','dist','.next'].includes(f.name)) return walk(full);
      if (extensions.length === 0 || extensions.includes(path.extname(f.name))) return [full];
      return [];
    });
  };
  return { ok: true, files: walk(abs).map(f => path.relative(abs, f)) };
}

function deleteFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return { ok: false, error: 'Not found' };
  fs.unlinkSync(abs);
  return { ok: true };
}

function createDir(dirPath) {
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
  return { ok: true, path: path.resolve(dirPath) };
}

// ── Shell Security ────────────────────────────────────────────────────────────

const SHELL_ALLOWLIST = [
  /^node\b/, /^npm\b/, /^npx\b/, /^git\b/, /^ls\b/, /^cat\b/, /^echo\b/,
  /^mkdir\b/, /^cp\b/, /^mv\b/, /^touch\b/, /^head\b/, /^tail\b/, /^grep\b/,
  /^find\b/, /^wc\b/, /^sed\b/, /^awk\b/, /^sort\b/, /^uniq\b/, /^jq\b/,
  /^curl\s+.*localhost/, // only allow curl to localhost
  /^python3?\b/
];

const SHELL_BLOCKLIST = [
  /rm\s+-rf?\s+\//, /rm\s+-rf?\s+~/, // dangerous rm
  /format\b/, /mkfs\b/, /dd\b/,       // disk ops
  /curl\s+.*https?:\/\/(?!localhost)/, // external curl
  /wget\b.*https?:\/\/(?!localhost)/,  // external wget
  />\s*\/etc/, />\s*\/usr/, />\s*\/bin/, // write to system dirs
  /sudo\b/, /su\b/,                    // privilege escalation
  /;\s*rm\b/, /&&\s*rm\b/, /\|\s*rm\b/ // chained rm
];

function isSafeCommand(cmd) {
  const trimmed = cmd.trim().toLowerCase();
  if (SHELL_BLOCKLIST.some(r => r.test(trimmed))) return false;
  if (SHELL_ALLOWLIST.some(r => r.test(trimmed))) return true;
  return false; // default deny
}

// ── Shell Tools ───────────────────────────────────────────────────────────────

async function runShell(command, opts = {}) {
  const { cwd = process.cwd(), timeout = 30000, allowFail = false, bypassSandbox = false } = opts;
  if (!bypassSandbox && !isSafeCommand(command)) {
    return { ok: false, error: 'Command blocked by security policy', cmd: command };
  }
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), command };
  } catch (err) {
    if (allowFail) return { ok: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message, command, exitCode: err.code };
    return { ok: false, error: err.stderr?.trim() || err.message, stdout: err.stdout?.trim() || '', command };
  }
}

// ── Git Tools ────────────────────────────────────────────────────────────────

async function gitInit(projectPath) {
  await runShell('git init', { cwd: projectPath, bypassSandbox: true });
  await runShell('git config user.email "forge@local"', { cwd: projectPath, bypassSandbox: true });
  await runShell('git config user.name "Forge AI"', { cwd: projectPath, bypassSandbox: true });
  return { ok: true };
}

async function gitStatus(projectPath) {
  return runShell('git status --short', { cwd: projectPath, allowFail: true, bypassSandbox: true });
}

async function gitCommit(projectPath, message) {
  await runShell('git add -A', { cwd: projectPath, bypassSandbox: true });
  // Strip shell-special chars from message to prevent injection via task titles with backticks
  const safeMsg = message.replace(/[`$\\]/g, '').replace(/"/g, "'");
  return runShell(`git commit -m "${safeMsg}"`, { cwd: projectPath, allowFail: true, bypassSandbox: true });
}

async function gitDiff(projectPath) {
  return runShell('git diff HEAD', { cwd: projectPath, allowFail: true, bypassSandbox: true });
}

// ── Test Runner ───────────────────────────────────────────────────────────────

async function detectTestFramework(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.jest) return 'jest';
    if (deps.mocha) return 'mocha';
    if (deps.vitest) return 'vitest';
    if (pkg.scripts?.test) return 'npm';
  }
  if (fs.existsSync(path.join(projectPath, 'pytest.ini')) ||
      fs.existsSync(path.join(projectPath, 'pyproject.toml'))) return 'pytest';
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) return 'cargo';
  return 'npm';
}

async function runTests(projectPath) {
  const framework = await detectTestFramework(projectPath);
  const cmds = { jest: 'npx jest --no-coverage 2>&1', mocha: 'npx mocha 2>&1',
    vitest: 'npx vitest run 2>&1', npm: 'npm test 2>&1',
    pytest: 'python3 -m pytest -v 2>&1', cargo: 'cargo test 2>&1' };
  const result = await runShell(cmds[framework] || 'npm test 2>&1', { cwd: projectPath, timeout: 60000, allowFail: true, bypassSandbox: true });
  return { ...result, framework, passed: result.ok };
}

// ── Package Manager ───────────────────────────────────────────────────────────

async function installDeps(projectPath) {
  if (fs.existsSync(path.join(projectPath, 'package.json'))) {
    return runShell('npm install', { cwd: projectPath, timeout: 120000, allowFail: true, bypassSandbox: true });
  }
  if (fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
    return runShell('pip3 install -r requirements.txt --break-system-packages', { cwd: projectPath, timeout: 120000, allowFail: true, bypassSandbox: true });
  }
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) {
    return runShell('cargo build', { cwd: projectPath, timeout: 180000, allowFail: true, bypassSandbox: true });
  }
  return { ok: false, error: 'No package manifest found' };
}

// ── Build Tool ────────────────────────────────────────────────────────────────

async function buildProject(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.scripts?.build) return runShell('npm run build 2>&1', { cwd: projectPath, timeout: 120000, allowFail: true, bypassSandbox: true });
  }
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) {
    return runShell('cargo build --release 2>&1', { cwd: projectPath, timeout: 180000, allowFail: true, bypassSandbox: true });
  }
  return { ok: true, stdout: 'No build step required' };
}

// ── Project Scaffold ──────────────────────────────────────────────────────────

async function scaffoldProject(projectId, stack = 'node') {
  const projectPath = path.join(PROJECTS_DIR, projectId);
  createDir(projectPath);
  createDir(path.join(projectPath, 'src'));
  createDir(path.join(projectPath, 'tests'));

  const scaffolds = {
    node: { 'package.json': JSON.stringify({ name: projectId, version: '1.0.0', scripts: { test: 'node --test tests/*.test.js', start: 'node src/index.js' }, devDependencies: {} }, null, 2),
            'src/index.js': '// Entry point\n', 'tests/.gitkeep': '' },
    python: { 'requirements.txt': '# Add dependencies here\n', 'src/__init__.py': '', 'src/main.py': '# Entry point\n', 'tests/__init__.py': '', 'tests/test_main.py': 'import unittest\n' },
    react: { 'package.json': JSON.stringify({ name: projectId, version: '1.0.0', scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' }, dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' }, devDependencies: { vite: '^5.0.0', vitest: '^1.0.0' } }, null, 2) }
  };

  const files = scaffolds[stack] || scaffolds.node;
  for (const [file, content] of Object.entries(files)) {
    writeFile(path.join(projectPath, file), content);
  }

  await gitInit(projectPath);
  await gitCommit(projectPath, 'Initial scaffold');
  return { ok: true, projectPath, stack };
}

module.exports = {
  readFile, writeFile, guardProjectPath, listFiles, deleteFile, createDir,
  runShell, isSafeCommand, gitInit, gitStatus, gitCommit, gitDiff,
  runTests, installDeps, buildProject, scaffoldProject, detectTestFramework,
  webSearch, fetchPage, searchNpm, searchStackOverflow
};

// ── Search cache (30-minute TTL) ──────────────────────────────────────────
const searchCache = new Map();
function getCached(key) {
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.ts < 30 * 60 * 1000) return hit.data;
  return null;
}
function setCache(key, data) { searchCache.set(key, { data, ts: Date.now() }); }

// ── Web Search (DuckDuckGo Instant Answer API, no key) ────────────────────
async function webSearch(query, maxResults = 5) {
  const cacheKey = `ddg:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const { exec } = require('child_process');
    const result = await new Promise(resolve => {
      const cmd = `curl -sL --max-time 12 --user-agent "Mozilla/5.0 (compatible; ForgeBot/1.0)" "https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1"`;
      exec(cmd, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => resolve(err ? '{}' : stdout));
    });

    const data = JSON.parse(result || '{}');
    const snippets = [];

    if (data.AbstractText) {
      snippets.push({
        title: data.Heading || query,
        snippet: data.AbstractText,
        url: data.AbstractURL || '',
        source: 'DuckDuckGo Abstract'
      });
    }
    (data.RelatedTopics || []).forEach(t => {
      if (snippets.length >= maxResults) return;
      if (t.Text) snippets.push({ title: t.Name || '', snippet: t.Text, url: t.FirstURL || '', source: 'Related' });
      // Nested topics
      if (t.Topics) t.Topics.forEach(st => {
        if (snippets.length >= maxResults) return;
        if (st.Text) snippets.push({ title: st.Name || '', snippet: st.Text, url: st.FirstURL || '', source: 'Related' });
      });
    });
    // Add Bing/Google snippet via a fallback HTML scrape if we got nothing
    if (snippets.length === 0) {
      const fallback = await webSearchFallback(query, maxResults);
      const out = { ok: true, query, results: fallback, abstract: '' };
      setCache(cacheKey, out);
      return out;
    }

    const out = { ok: true, query, results: snippets, abstract: data.AbstractText || '' };
    setCache(cacheKey, out);
    return out;
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  }
}

// Fallback: scrape Bing search results HTML for snippets
async function webSearchFallback(query, maxResults = 4) {
  try {
    const { exec } = require('child_process');
    const html = await new Promise(resolve => {
      const cmd = `curl -sL --max-time 12 --user-agent "Mozilla/5.0" "https://www.bing.com/search?q=${encodeURIComponent(query)}" 2>/dev/null | grep -oP '(?<=<p>)[^<]{30,300}(?=</p>)' | head -${maxResults}`;
      exec(cmd, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => resolve(err ? '' : stdout));
    });
    return html.trim().split('\n').filter(Boolean).map(s => ({
      title: '', snippet: s.trim(), url: '', source: 'Bing'
    }));
  } catch { return []; }
}

// ── npm Package Search ────────────────────────────────────────────────────
async function searchNpm(query, maxResults = 5) {
  const cacheKey = `npm:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { exec } = require('child_process');
    const result = await new Promise(resolve => {
      const cmd = `curl -sL --max-time 10 "https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${maxResults}"`;
      exec(cmd, { encoding: 'utf8', timeout: 12000 }, (err, stdout) => resolve(err ? '{}' : stdout));
    });
    const data = JSON.parse(result || '{}');
    const packages = (data.objects || []).map(o => ({
      name: o.package?.name,
      version: o.package?.version,
      description: o.package?.description,
      downloads: o.downloads?.monthly,
      url: o.package?.links?.npm,
      score: o.score?.final
    }));
    const out = { ok: true, query, packages };
    setCache(cacheKey, out);
    return out;
  } catch (e) {
    return { ok: false, error: e.message, packages: [] };
  }
}

// ── StackOverflow Search ──────────────────────────────────────────────────
async function searchStackOverflow(query, maxResults = 5) {
  const cacheKey = `so:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  try {
    const { exec } = require('child_process');
    const result = await new Promise(resolve => {
      const enc = encodeURIComponent(query);
      const cmd = `curl -sL --max-time 12 "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=${enc}&site=stackoverflow&filter=withbody&pagesize=${maxResults}&key="`;
      exec(cmd, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => resolve(err ? '{}' : stdout));
    });
    const data = JSON.parse(result || '{}');
    const questions = (data.items || []).map(q => ({
      title: q.title,
      score: q.score,
      answered: q.is_answered,
      answers: q.answer_count,
      url: q.link,
      tags: (q.tags || []).join(', '),
      body: q.body ? q.body.replace(/<[^>]*>/g,'').slice(0,300) : ''
    }));
    const out = { ok: true, query, questions };
    setCache(cacheKey, out);
    return out;
  } catch (e) {
    return { ok: false, error: e.message, questions: [] };
  }
}

async function fetchPage(url, maxChars = 8000) {
  try {
    const { exec } = require('child_process');
    // Strip HTML tags, decode common entities, remove blank lines
    const content = await new Promise(resolve => {
      const cmd = `curl -sL --max-time 15 --user-agent "Mozilla/5.0" "${url}" | sed 's/<[^>]*>//g' | sed 's/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g; s/&nbsp;/ /g' | sed '/^[[:space:]]*$/d' | head -c ${maxChars}`;
      exec(cmd, { encoding: 'utf8', timeout: 18000 }, (err, stdout) => resolve(err ? '' : stdout));
    });
    return { ok: true, url, content: content.trim(), chars: content.length };
  } catch (e) {
    return { ok: false, error: e.message, content: '' };
  }
}
