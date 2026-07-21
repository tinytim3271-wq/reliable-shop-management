#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_ENTRY = path.join(ROOT, 'dist', 'index.js');

function percentile(values, pct) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  const bounded = Math.min(Math.max(index, 0), sorted.length - 1);
  return sorted[bounded];
}

function runInvocation() {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(process.execPath, [APP_ENTRY], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', (code, signal) => {
      const finishedAt = process.hrtime.bigint();
      const latencyMs = Number(finishedAt - startedAt) / 1e6;
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        latencyMs,
        pass: code === 0 && /Reliable Shop Management app is installed and running\./.test(stdout),
      });
    });
  });
}

async function main() {
  if (!fs.existsSync(APP_ENTRY)) {
    throw new Error('Build output missing. Run npm run build from the repository root first.');
  }

  const runCount = Number(process.env.PHASE3_LOAD_RUNS || 20);
  const concurrency = Math.max(1, Number(process.env.PHASE3_LOAD_CONCURRENCY || 5));
  const results = [];

  for (let offset = 0; offset < runCount; offset += concurrency) {
    const batchSize = Math.min(concurrency, runCount - offset);
    const batch = await Promise.all(Array.from({ length: batchSize }, () => runInvocation()));
    results.push(...batch);
  }

  const durations = results.map((item) => item.latencyMs);
  const passes = results.filter((item) => item.pass).length;
  const successRate = runCount === 0 ? 0 : (passes / runCount) * 100;
  const payload = {
    kind: 'phase3-load-baseline',
    pass: passes === runCount,
    timestamp: new Date().toISOString(),
    baseUrl: APP_ENTRY,
    results: [
      {
        scenario: 'cli-invocation',
        totalRequests: runCount,
        successRate,
        latencyMs: {
          p50: percentile(durations, 50),
          p95: percentile(durations, 95),
          max: Math.max(...durations),
          mean: durations.reduce((sum, value) => sum + value, 0) / Math.max(durations.length, 1),
        },
      },
    ],
  };

  for (const [index, result] of results.entries()) {
    const status = result.pass ? 'PASS' : 'FAIL';
    const message = result.stdout.trim().split(/\r?\n/)[0] || 'no stdout';
    console.log(`[${status}] run ${index + 1}/${runCount}: ${message} (${result.latencyMs.toFixed(2)} ms)`);
  }

  console.log('RESULT_JSON:' + JSON.stringify(payload));
  process.exit(payload.pass ? 0 : 1);
}

main().catch((error) => {
  console.error('Load baseline failed:', error.message);
  process.exit(1);
});