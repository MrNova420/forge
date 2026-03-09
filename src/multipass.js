// Multi-pass generation: Best-of-N sampling strategy
// For small models (phi3.5), sampling multiple fresh generations at varied
// temperatures outperforms revision (which confuses the model and produces
// empty outputs). Pick the best scored candidate.
const { generate, sleep, DEFAULT_CTX } = require('./ollama');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// runEslint — lint generated code via ESLint, returns { errors, warnings }
// ---------------------------------------------------------------------------
function runEslint(code) {
  const tmpFile = path.join('/tmp', `forge_eslint_${process.pid}_${Date.now()}.js`);
  try {
    fs.writeFileSync(tmpFile, code, 'utf8');
    const eslintConfig = JSON.stringify({
      env: { node: true, es2021: true },
      rules: { 'no-undef': 'warn', 'no-unused-vars': 'warn', 'no-console': 'off' }
    });
    const result = spawnSync(
      'npx',
      ['eslint', '--no-eslintrc', '-c', eslintConfig, '--format', 'json', tmpFile],
      { encoding: 'utf8', timeout: 10000, shell: false }
    );
    // Exit code 2 = lint error (fatal), 1 = lint warnings/errors found, 0 = clean
    if (result.status === null) return { errors: 0, warnings: 0 }; // timeout/not found
    const output = (result.stdout || '').trim();
    if (!output || !output.startsWith('[')) return { errors: 0, warnings: 0 };
    const parsed = JSON.parse(output);
    const totals = parsed.reduce((acc, f) => {
      acc.errors   += f.errorCount   || 0;
      acc.warnings += f.warningCount || 0;
      return acc;
    }, { errors: 0, warnings: 0 });
    return totals;
  } catch (_) {
    return { errors: 0, warnings: 0 };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Error pattern library — track common issues across tasks
// ---------------------------------------------------------------------------
const _errorPatterns = {};
function recordError(pattern) { _errorPatterns[pattern] = (_errorPatterns[pattern] || 0) + 1; }
function getTopErrors() { return Object.entries(_errorPatterns).sort((a, b) => b[1] - a[1]).slice(0, 10); }

// ---------------------------------------------------------------------------
// scoreCode — real quality scorer
// ---------------------------------------------------------------------------
function scoreCode(text, knownFiles = []) {
  if (!text || text.trim().length < 50) {
    return { score: 1, issues: ['Empty output'], suggestions: ['Generate actual code'] };
  }

  const issues      = [];
  const suggestions = [];
  let score         = 5;

  // ── Basic sanity ──────────────────────────────────────────────────────────
  const hasGibberish = /Q-\d+Based on|apologize|Natural Language.*\n|hereby_\d/i.test(text);
  const hasCode      = /function |const |class |def |import |module\.exports|if \(|for \(/m.test(text);

  if (hasGibberish || !hasCode) {
    return { score: 1, issues: ['Model generated non-code text'], suggestions: ['Model needs clearer prompt'] };
  }

  // ── FILE: prefix ──────────────────────────────────────────────────────────
  const hasFilePrefix = /^FILE:\s*\S+/m.test(text);
  if (hasFilePrefix) score += 1;
  else               issues.push('Missing FILE: prefix on first line');

  // ── Markdown fences ───────────────────────────────────────────────────────
  const hasFences = /^```/m.test(text);
  if (!hasFences) score += 0.5;
  else            issues.push('Wrapped in markdown fences — output raw code only');

  // ── TODOs / stubs ─────────────────────────────────────────────────────────
  const hasTodos = /\bTODO\b|\bFIXME\b|\bstub\b|\bplaceholder\b/i.test(text);
  if (!hasTodos) score += 1;
  else           issues.push('Has TODO/stub/placeholder — incomplete');

  // ── Exports ───────────────────────────────────────────────────────────────
  const hasExports = /module\.exports|export\s+(default|const|function|class)|__all__/.test(text);
  if (hasExports) score += 0.5;
  else            issues.push('No module.exports or ES6 export found');

  // ── Error handling ────────────────────────────────────────────────────────
  const hasErrorHandling = /try\s*\{|\.catch\s*\(|on\s*\(\s*['"]error['"]/m.test(text);
  if (hasErrorHandling) score += 0.5;
  else                  issues.push('No error handling (try/catch, .catch, error event)');

  // ── Input validation ──────────────────────────────────────────────────────
  const hasValidation = /if\s*\(.*?(===?\s*null|===?\s*undefined|![\w.]+|typeof\s+\w+\s*!==?\s*['"])/m.test(text)
                     || /throw\s+new\s+\w*Error/m.test(text);
  if (hasValidation) score += 0.5;
  else               suggestions.push('Consider adding input validation');

  // ── Comments / JSDoc ──────────────────────────────────────────────────────
  const hasComments = /\/\*\*|\/\/[^\n]{3,}/.test(text);
  if (hasComments) score += 0.5;
  else             suggestions.push('Add JSDoc or inline comments');

  // ── Line count ────────────────────────────────────────────────────────────
  const lineCount = text.split('\n').length;
  if (lineCount > 30) score += 0.5;
  if (lineCount > 50) score += 0.5;

  // ── console.log in production ─────────────────────────────────────────────
  const hasConsoleLog = /console\.log\s*\(/.test(text);
  if (hasConsoleLog) {
    score -= 0.5;
    issues.push('console.log left in code (warn: -0.5)');
    recordError('console.log in production');
  }

  // ── Hardcoded secrets ─────────────────────────────────────────────────────
  const hasSecrets = /(?:password|apiKey|api_key|secret|token)\s*[:=]\s*['"][^'"]{4,}['"]/i.test(text);
  if (hasSecrets) {
    score -= 2;
    issues.push('Hardcoded credential/secret detected (-2)');
    recordError('hardcoded secret');
  }

  // ── Bad patterns ──────────────────────────────────────────────────────────
  // Empty catch blocks: catch(e){} or catch (err) {}
  const hasEmptyCatch = /catch\s*\([^)]*\)\s*\{\s*\}/.test(text);
  if (hasEmptyCatch) {
    score -= 1;
    issues.push('Empty catch block detected (-1)');
    recordError('empty catch block');
  }

  // Callback hell: 3+ levels of nested callbacks (rudimentary indent depth check)
  const cbHell = (text.match(/function\s*\([^)]*\)\s*\{/g) || []).length >= 3
              && /\},\s*function\s*\(/.test(text);
  if (cbHell) {
    score -= 0.5;
    issues.push('Possible callback hell (3+ nested callbacks, -0.5)');
    recordError('callback hell');
  }

  // ── Real JS syntax check via `node --check` ───────────────────────────────
  // Extract the first JS block (skip FILE: header lines)
  const jsLines = text.split('\n').filter(l => !/^FILE:\s*/.test(l.trim()));
  const jsCode  = jsLines.join('\n');

  // Only bother if the text looks like JS (not Python etc.)
  const looksLikeJS = /\bconst\b|\blet\b|\bvar\b|\bfunction\b|\brequire\b|\bmodule\.exports\b/.test(jsCode);
  if (looksLikeJS && !hasFences) {
    const tmpFile = path.join('/tmp', `forge_check_${process.pid}_${Date.now()}.js`);
    try {
      fs.writeFileSync(tmpFile, jsCode, 'utf8');
      const result = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) {
        const errMsg = (result.stderr || '').split('\n')[0].replace(tmpFile, '<generated>').trim();
        score -= 2;
        issues.push(`Syntax error (node --check): ${errMsg} (-2)`);
        recordError('syntax error');
      } else {
        score += 0.5; // bonus for clean syntax
      }
    } catch (_) {
      // If node --check itself fails for env reasons, skip silently
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }

    // ── ESLint scoring ──────────────────────────────────────────────────────
    const eslintResult = runEslint(jsCode);
    if (eslintResult.errors > 0) {
      score -= 1;
      issues.push(`ESLint errors: ${eslintResult.errors} (-1)`);
      recordError('eslint errors');
    } else if (eslintResult.warnings === 0) {
      score += 0.5; // clean lint bonus
    }
  }

  // ── Require resolution check ───────────────────────────────────────────────
  const NODE_BUILTINS = new Set([
    'path','fs','os','http','https','crypto','events','stream','util','url',
    'child_process','net','dns','readline','assert','buffer','querystring',
    'zlib','timers','cluster','worker_threads'
  ]);
  const forgeModulesDir = path.join(__dirname, '../node_modules');
  const allRequireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  let unresolvedPenalty = 0;
  while ((m = allRequireRe.exec(text)) !== null) {
    const req = m[1];
    if (req.startsWith('./') || req.startsWith('../')) {
      // Relative path — check against knownFiles
      const bare = req.replace(/^\.\//, '').replace(/\.(js|mjs|cjs)$/, '');
      const found = knownFiles.some(f => {
        const fb = f.replace(/^\.\//, '').replace(/\.(js|mjs|cjs)$/, '');
        return fb === bare || fb.endsWith('/' + bare);
      });
      if (!found && knownFiles.length > 0) {
        issues.push(`Unresolved relative require: '${req}'`);
        score -= 0.5;
        recordError('unresolved require');
      }
    } else {
      // Bare module name — skip builtins, check node_modules
      const pkgName = req.startsWith('@') ? req.split('/').slice(0, 2).join('/') : req.split('/')[0];
      if (!NODE_BUILTINS.has(pkgName)) {
        const exists = fs.existsSync(path.join(forgeModulesDir, pkgName));
        if (!exists && unresolvedPenalty < 1.5) {
          issues.push(`Unresolved bare module: '${pkgName}' not in node_modules (-0.5)`);
          score -= 0.5;
          unresolvedPenalty += 0.5;
          recordError('unresolved bare module');
        }
      }
    }
  }

  score = Math.max(1, Math.min(10, Math.round(score * 2) / 2)); // clamp, keep .5 steps

  return {
    score,
    missing_file_prefix: !hasFilePrefix,
    has_todos: hasTodos,
    issues,
    suggestions,
  };
}

// Temperatures to try across sampling rounds (varied for diversity)
const TEMPS = [0.2, 0.3, 0.15, 0.25];

async function multipass(task, systemPrompt, opts = {}) {
  const { rounds = 3, minScore = 7, model } = opts;

  let best = null;
  let bestScore = 0;
  const history = [];
  let totalTokens = 0;
  let totalTokPerSec = 0;
  let tokRounds = 0;

  for (let round = 1; round <= rounds; round++) {
    if (round > 1) await sleep(1500);

    const temp = TEMPS[(round - 1) % TEMPS.length];
    const generated = await generate(task, { system: systemPrompt, model, numCtx: DEFAULT_CTX, temperature: temp });

    // Guard against degenerate/empty outputs
    if (!generated.text || generated.text.trim().length < 30) {
      console.log(`[Round ${round}] ⚠ Degenerate output (${generated.tokens} tokens) — skipping`);
      history.push({ score: 1, issues: ['Empty generation'], round, tokens: generated.tokens });
      continue;
    }

    totalTokens += generated.tokens || 0;
    if ((generated.tokPerSec || 0) > 0) { totalTokPerSec += generated.tokPerSec; tokRounds++; }

    const critique = scoreCode(generated.text);
    console.log(`[Round ${round}] Generated (${generated.tokens ?? '?'} tokens, prompt: ${generated.promptTokens ?? '?'}, ${generated.tokPerSec ?? 0} tok/s)`);
    console.log(`[Round ${round}] Score: ${critique.score}/10 (FILE:${!critique.missing_file_prefix} code:${!critique.issues.includes('Model generated non-code text')})`);

    history.push({ ...critique, round, tokens: generated.tokens });

    if (critique.score > bestScore) {
      bestScore = critique.score;
      best = generated.text;
    }

    if (critique.score >= minScore) {
      console.log(`[Round ${round}] ✅ Quality threshold reached`);
      break;
    }
  }

  const sessionSummary = bestScore > 0
    ? `Best score: ${bestScore}/10 after ${history.length} rounds.`
    : null;

  return {
    output: best || '',
    score: bestScore,
    rounds: history.length,
    history,
    sessionSummary,
    tokens: totalTokens,
    tokPerSec: tokRounds > 0 ? Math.round((totalTokPerSec / tokRounds) * 10) / 10 : 0,
  };
}

module.exports = { multipass, scoreCode, recordError, getTopErrors };
