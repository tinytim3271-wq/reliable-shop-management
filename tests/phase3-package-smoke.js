#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function runBinary(binaryPath) {
  return spawnSync(binaryPath, [], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: process.platform === 'win32',
  });
}

function main() {
  const packOutput = execSync('npm pack --json', {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const packDetails = JSON.parse(packOutput.trim());
  const tarballName = Array.isArray(packDetails) ? packDetails[0]?.filename : packDetails?.filename;

  if (!tarballName) {
    throw new Error('npm pack did not return a tarball name.');
  }

  const tarballPath = path.join(ROOT, tarballName);
  const tempPrefix = fs.mkdtempSync(path.join(os.tmpdir(), 'reliable-shop-phase3-'));
  execSync(`npm install --prefix "${tempPrefix}" "${tarballPath}"`, {
    cwd: ROOT,
    stdio: 'pipe',
  });

  const binaryName = process.platform === 'win32' ? 'reliable-shop.cmd' : 'reliable-shop';
  const binaryPath = path.join(tempPrefix, 'node_modules', '.bin', binaryName);
  const run = runBinary(binaryPath);
  const stdout = run.stdout || '';
  const stderr = run.stderr || '';

  const checks = [
    {
      name: 'packed binary exits successfully',
      expected: [0],
      actual: run.status,
      pass: run.status === 0,
    },
    {
      name: 'packed binary prints install banner',
      expected: ['Reliable Shop Management app is installed and running.'],
      actual: stdout.trim().split(/\r?\n/)[0] || '',
      pass: /Reliable Shop Management app is installed and running\./.test(stdout),
    },
    {
      name: 'packed binary does not write errors',
      expected: ['empty stderr'],
      actual: stderr.trim() || 'empty stderr',
      pass: stderr.trim().length === 0,
    },
  ];

  for (const check of checks) {
    const status = check.pass ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${check.name}: expected ${check.expected.join('/')} got ${check.actual}`);
  }

  const payload = {
    kind: 'phase3-package-smoke',
    pass: checks.every((check) => check.pass),
    timestamp: new Date().toISOString(),
    tarballPath,
    binaryPath,
    checks,
  };

  fs.writeFileSync(path.join(__dirname, 'PHASE_3_PACKAGE_SMOKE_REPORT.md'), [
    '# Phase 3 Package Smoke Report',
    '',
    `- Timestamp: ${payload.timestamp}`,
    `- Tarball: ${payload.tarballPath}`,
    `- Binary: ${payload.binaryPath}`,
    `- Status: ${payload.pass ? 'PASS' : 'FAIL'}`,
    '',
    '| Check | Expected | Actual | Result |',
    '|---|---|---|---|',
    ...checks.map((check) => `| ${check.name} | ${check.expected.join('/')} | ${check.actual} | ${check.pass ? 'PASS' : 'FAIL'} |`),
    '',
  ].join('\n'), 'utf8');

  console.log('RESULT_JSON:' + JSON.stringify(payload));
  process.exit(payload.pass ? 0 : 1);
}

main();