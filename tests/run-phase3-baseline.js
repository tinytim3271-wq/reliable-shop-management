#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HISTORY_FILE_NAME = 'PHASE_3_BASELINE_HISTORY.json';

function runScript(fileName) {
  const scriptPath = path.join(__dirname, fileName);
  const output = execSync(`node "${scriptPath}"`, {
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('RESULT_JSON:'));

  if (!resultLine) {
    throw new Error(`No RESULT_JSON found in output for ${fileName}`);
  }

  return {
    output,
    result: JSON.parse(resultLine.replace('RESULT_JSON:', '')),
  };
}

function safeRun(fileName) {
  try {
    return runScript(fileName);
  } catch (error) {
    const output = error.stdout ? String(error.stdout) : String(error.message);
    const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('RESULT_JSON:'));

    if (!resultLine) {
      throw error;
    }

    return {
      output,
      result: JSON.parse(resultLine.replace('RESULT_JSON:', '')),
    };
  }
}

function buildReport(load, security) {
  const generatedAt = new Date().toISOString();
  const overallPass = load.pass && security.pass;

  const lines = [];
  lines.push('# Phase 3 Baseline Report');
  lines.push('');
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Overall Status: ${overallPass ? 'PASS' : 'FAIL'}`);
  lines.push('');

  lines.push('## Load Baseline');
  lines.push(`- Status: ${load.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`- Target: ${load.baseUrl}`);
  lines.push('');
  lines.push('| Scenario | Requests | Success Rate | P50 (ms) | P95 (ms) | Max (ms) |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const item of load.results || []) {
    lines.push(
      `| ${item.scenario} | ${item.totalRequests} | ${item.successRate.toFixed(2)}% | ${item.latencyMs.p50.toFixed(2)} | ${item.latencyMs.p95.toFixed(2)} | ${item.latencyMs.max.toFixed(2)} |`
    );
  }
  lines.push('');

  lines.push('## Security Baseline');
  lines.push(`- Status: ${security.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`- Target: ${security.baseUrl}`);
  lines.push('');
  lines.push('| Check | Expected | Actual | Result |');
  lines.push('|---|---|---:|---|');
  for (const check of security.checks || []) {
    lines.push(`| ${check.name} | ${check.expected.join('/')} | ${check.actual} | ${check.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');

  lines.push('## Next Actions');
  lines.push('1. If load baseline fails, inspect build output and repeated CLI invocation cost first.');
  lines.push('2. If security baseline fails, fix any stdout/stderr leakage before widening scope.');
  lines.push('3. Review baseline trend history before changing thresholds.');
  lines.push('');

  return lines.join('\n');
}

function readHistory(historyPath) {
  if (!fs.existsSync(historyPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function createHistoryEntry(loadResult, securityResult) {
  return {
    timestamp: new Date().toISOString(),
    overallPass: Boolean(loadResult.pass && securityResult.pass),
    load: {
      pass: Boolean(loadResult.pass),
      summary: (loadResult.results || []).reduce((summary, item) => {
        summary[item.scenario] = {
          successRate: item.successRate,
          p95Ms: item.latencyMs?.p95,
          maxMs: item.latencyMs?.max,
        };
        return summary;
      }, {}),
    },
    security: {
      pass: Boolean(securityResult.pass),
      checksPassed: (securityResult.checks || []).filter((check) => check.pass).length,
      checksTotal: (securityResult.checks || []).length,
    },
  };
}

function writeHistory(historyPath, entry) {
  const previous = readHistory(historyPath);
  const next = [...previous, entry].slice(-200);
  fs.writeFileSync(historyPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

function appendTrendSummary(reportPath, history) {
  const recent = history.slice(-5);
  const lines = [];
  lines.push('## Baseline Trend');
  lines.push(`- History entries stored: ${history.length}`);
  lines.push('');
  lines.push('| Timestamp | Overall | Load | Security |');
  lines.push('|---|---|---|---|');

  for (const entry of recent) {
    lines.push(
      `| ${entry.timestamp} | ${entry.overallPass ? 'PASS' : 'FAIL'} | ${entry.load?.pass ? 'PASS' : 'FAIL'} | ${entry.security?.pass ? 'PASS' : 'FAIL'} |`
    );
  }

  lines.push('');
  fs.appendFileSync(reportPath, lines.join('\n'), 'utf8');
}

function main() {
  console.log('Running Phase 3 baseline (load + security)...');

  const loadRun = safeRun('phase3-load-baseline.js');
  const securityRun = safeRun('phase3-security-baseline.js');

  process.stdout.write(loadRun.output);
  process.stdout.write(securityRun.output);

  const report = buildReport(loadRun.result, securityRun.result);
  const reportPath = path.join(__dirname, 'PHASE_3_BASELINE_REPORT.md');
  fs.writeFileSync(reportPath, report, 'utf8');

  const historyPath = path.join(__dirname, HISTORY_FILE_NAME);
  const historyEntry = createHistoryEntry(loadRun.result, securityRun.result);
  const history = writeHistory(historyPath, historyEntry);
  appendTrendSummary(reportPath, history);

  const overallPass = loadRun.result.pass && securityRun.result.pass;
  console.log(`Report written: ${reportPath}`);
  console.log(`History written: ${historyPath}`);
  console.log(`Phase 3 baseline status: ${overallPass ? 'PASS' : 'FAIL'}`);

  process.exit(overallPass ? 0 : 1);
}

main();