const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');

function initialize(directory) {
  const database = parseEnv(fs.readFileSync(path.join(directory, 'database.env'), 'utf8'));
  for (const key of ['MYSQL_URL', 'MIGRATION_DATABASE_URL']) {
    if (!database[key] || /[\r\n"\\]/.test(database[key])) throw new Error('Unexpected database URL format');
  }
  // Never evaluate shell input and never replace existing secrets.
  const configs = {
    'app.env': `NODE_ENV=development\nHOST=127.0.0.1\nPORT=3000\nMYSQL_URL="${database.MYSQL_URL}"\nWECHAT_APP_ID=\nWECHAT_APP_SECRET=\nAUTH_SESSION_TTL_SECONDS=604800\nENABLE_DEV_LOGIN=false\nDEV_LOGIN_KEY=\nINVITE_CODE_SECRET=${randomBytes(32).toString('hex')}\n`,
    'migration.env': `MIGRATION_DATABASE_URL="${database.MIGRATION_DATABASE_URL}"\n`,
  };
  for (const [name, content] of Object.entries(configs)) {
    try { fs.writeFileSync(path.join(directory, name), content, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

async function check(directory, envFile, schema) {
  const requireRelease = createRequire(path.join(directory, 'package.json'));
  const { validateEnvironment, databaseOptions } = requireRelease('./dist/config');
  const env = validateEnvironment(parseEnv(fs.readFileSync(envFile, 'utf8')));
  if (env.HOST !== '127.0.0.1' || env.PORT !== 3000) throw new Error('Deployment requires 127.0.0.1:3000');
  const options = databaseOptions(env.MYSQL_URL);
  if (options.user !== 'growth_app' || options.database !== 'growth_diary' || options.host !== '127.0.0.1') throw new Error('Expected the local growth_app runtime account');
  if (!schema) return;
  const connection = await requireRelease('mysql2/promise').createConnection(options);
  try {
    const [version] = await connection.query('SELECT VERSION() AS version');
    if (!/^8\.4\./.test(version[0].version)) throw new Error('MySQL 8.4 required');
    const { INITIAL_TABLE_NAMES } = requireRelease('./dist/database/migrations/1790985600000-initial-schema');
    for (const table of [...INITIAL_TABLE_NAMES, 'auth_sessions']) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid table identifier');
      await connection.query(`SELECT 1 FROM \`${table}\` LIMIT 1`);
    }
    const { createMigrationDataSource } = requireRelease('./dist/database/data-source');
    const expected = createMigrationDataSource(env.MYSQL_URL).options.migrations.map((Migration) => new Migration().name);
    const [applied] = await connection.query('SELECT name FROM schema_migrations');
    if (expected.length !== applied.length || expected.some((name) => !applied.some((row) => row.name === name))) {
      throw new Error('Migration history mismatch; code rollback requires compatible schema');
    }
  } finally { await connection.end(); }
}

module.exports = { initialize, check };
if (require.main === module) {
  const [command, directory, envFile] = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (command === 'init') return initialize(directory);
    if (command === 'config' || command === 'schema') return check(directory, envFile, command === 'schema');
    throw new Error('Unknown command');
  }).catch(() => {
    // SQL and URL errors may carry credentials; do not print the original error.
    console.error('Release check failed. Check private config, MySQL version, tables and migration history.');
    process.exitCode = 1;
  });
}
