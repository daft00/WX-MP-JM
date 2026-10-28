const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REQUIRED = [
  'stage7_privacy_and_data_deletion', 'mysql_migrations_and_access_control',
  'cos_upload_export_and_expiry', 'encrypted_offsite_backup', 'isolated_restore_and_media',
  'monitor_alert_delivery', 'cloud_budget_alerts', 'tls_auto_renewal',
  'icp_and_miniprogram_filing', 'wechat_categories_privacy_domains',
  'ios_android_two_families_three_accounts', 'reviewer_invitation_flow', 'security_updates',
];

function evaluate(root, evidence, revision, dirty, now = new Date()) {
  const issues = [];
  const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
  if (project.setting?.urlCheck !== true) issues.push('project_domain_validation_disabled');
  const localPath = path.join(root, 'project.private.config.json');
  if (fs.existsSync(localPath) && JSON.parse(fs.readFileSync(localPath, 'utf8')).setting?.urlCheck === false) {
    issues.push('local_domain_validation_disabled');
  }
  if (dirty) issues.push('working_tree_not_clean');
  if (!/^[a-f0-9]{40}$/.test(evidence.release_commit || '') || evidence.release_commit !== revision) issues.push('evidence_revision_mismatch');
  for (const key of REQUIRED) {
    const item = evidence.checks?.[key];
    const age = now.getTime() - Date.parse(item?.checked_at);
    if (item?.passed !== true || typeof item?.evidence !== 'string' || !item.evidence.trim() || !Number.isFinite(age) || age < 0 || age > 14 * 86400000) {
      issues.push(key);
    }
  }
  const trial = evidence.trial;
  const start = Date.parse(trial?.started_at), end = Date.parse(trial?.finished_at);
  if (trial?.passed !== true || typeof trial?.evidence !== 'string' || !trial.evidence.trim()
    || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 7 * 86400000
    || end > now.getTime() || now.getTime() - end > 14 * 86400000) issues.push('one_week_trial');
  return { status: issues.length ? 'blocked' : 'ready_for_manual_submission', issues,
    scope: 'Local configuration and operator evidence only; does not publish or guarantee WeChat approval' };
}

module.exports = { evaluate, REQUIRED };
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    const report = evaluate(root, evidence, revision, dirty);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.issues.length ? 1 : 0;
  } catch {
    console.error('Release check failed: provide a readable evidence JSON and valid project configuration.');
    process.exitCode = 1;
  }
}
