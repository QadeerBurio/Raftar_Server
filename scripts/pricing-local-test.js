// Optional local runner. Tooling is installed separately, outside application dependencies.
const path = require('path');
const fs = require('fs');
const {
  spawn
} = require('child_process');
process.env.MONGOMS_DOWNLOAD_DIR = path.resolve(__dirname, '../../.pricing-test-tools/binaries');
const {
  MongoMemoryReplSet
} = require('../../.pricing-test-tools/node_modules/mongodb-memory-server');
(async () => {
  const dbPath = fs.mkdtempSync(path.resolve(__dirname, '../../.pricing-test-tools/database-'));
  const repl = await MongoMemoryReplSet.create({
    instanceOpts: [{
      dbPath
    }],
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger'
    }
  });
  try {
    const child = spawn(process.execPath, (process.argv.includes('--all') ? ['--test','tests/pricing-math.test.js','tests/pricing-integration.test.js','tests/recovery.test.js'] : process.argv.includes('--recovery') ? ['--test','tests/recovery.test.js'] : ['--test', 'tests/pricing-math.test.js', 'tests/pricing-integration.test.js']), {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PRICING_TEST_URI: repl.getUri()
      },
      stdio: 'inherit'
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    process.exitCode = code || 0;
  } finally {
    await repl.stop();
  }
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
});
