const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluate, REQUIRED } = require('../scripts/release-readiness.cjs');

test('release gate requires current evidence, domain checks and a complete one-week trial', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'growth-release-'));
  try {
    fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ setting: { urlCheck: true } }));
    const now = new Date('2026-10-26T00:00:00Z');
    const revision = 'a'.repeat(40);
    const evidence = { release_commit: revision, checks: Object.fromEntries(REQUIRED.map(key => [key, { passed: true, checked_at: now.toISOString(), evidence: 'local test report' }])),
      trial: { passed: true, started_at: '2026-10-18T00:00:00Z', finished_at: '2026-10-25T00:00:00Z', evidence: 'trial log' } };
    assert.equal(evaluate(root, evidence, revision, false, now).issues.length, 0);
    assert.ok(evaluate(root, evidence, revision, true, now).issues.includes('working_tree_not_clean'));
    evidence.checks.stage7_privacy_and_data_deletion.passed = false;
    evidence.checks.encrypted_offsite_backup.checked_at = '2026-09-01T00:00:00Z';
    evidence.trial.started_at = '2026-10-24T00:00:00Z';
    fs.writeFileSync(path.join(root, 'project.private.config.json'), JSON.stringify({ setting: { urlCheck: false } }));
    const issues = evaluate(root, evidence, revision, false, now).issues;
    for (const key of ['local_domain_validation_disabled', 'stage7_privacy_and_data_deletion', 'encrypted_offsite_backup', 'one_week_trial']) assert.ok(issues.includes(key));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
