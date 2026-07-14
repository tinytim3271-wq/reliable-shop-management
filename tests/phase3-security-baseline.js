#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_ENTRY = path.join(ROOT, 'dist', 'index.js');

function runApp(extraEnv = {}, args = []) {
  return spawnSync(process.execPath, [APP_ENTRY, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function main() {
  if (!fs.existsSync(APP_ENTRY)) {
    throw new Error('Build output missing. Run npm run build from the repository root first.');
  }

  const secret = 'phase3-secret-value';
  const run = runApp(
    {
      PHASE3_SECRET: secret,
      PHASE3_TOKEN: 'should-not-appear',
    },
    ['--username=intruder', `--token=${secret}`]
  );

  const stdout = run.stdout || '';
  const stderr = run.stderr || '';
  const checks = [
    {
      name: 'app exits successfully',
      expected: [0],
      actual: run.status,
      pass: run.status === 0,
    },
    {
      name: 'timestamped install message is printed',
      expected: ['Reliable Shop Management app is installed and running.'],
      actual: stdout.trim().split(/\r?\n/)[0] || '',
      pass: /Reliable Shop Management app is installed and running\./.test(stdout),
    },
    {
      name: 'secret env value is not echoed',
      expected: ['not present'],
      actual: stdout.includes(secret) || stderr.includes(secret) ? secret : 'not present',
      pass: !stdout.includes(secret) && !stderr.includes(secret),
    },
    {
      name: 'unexpected cli arguments are not echoed',
      expected: ['not present'],
      actual: stdout.includes('--username=intruder') || stderr.includes('--username=intruder') ? '--username=intruder' : 'not present',
      pass: !stdout.includes('--username=intruder') && !stderr.includes('--username=intruder'),
    },
  ];

  for (const check of checks) {
    const status = check.pass ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${check.name}: expected ${check.expected.join('/')} got ${check.actual}`);
  }

  const payload = {
    kind: 'phase3-security-baseline',
    pass: checks.every((check) => check.pass),
    timestamp: new Date().toISOString(),
    baseUrl: APP_ENTRY,
    checks,
  };

  console.log('RESULT_JSON:' + JSON.stringify(payload));
  process.exit(payload.pass ? 0 : 1);
}

main();