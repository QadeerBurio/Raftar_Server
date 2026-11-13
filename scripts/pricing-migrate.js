// Run first without --apply. Use an explicitly selected database, never implicit server/.env.
const mongoose = require('mongoose');
const {
  money,
  assert
} = require('../pricing/math');
const models = require('../pricing/models');
const Ride = require('../models/Ride');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Payment = require('../models/Payment');
async function run() {
  assert(process.env.PRICING_MIGRATION_URI, 'Set PRICING_MIGRATION_URI explicitly');
  await mongoose.connect(process.env.PRICING_MIGRATION_URI, {
    autoIndex: false,
    serverSelectionTimeoutMS: 8000
  });
  const applicationModels = require('fs').readdirSync(require('path').join(__dirname, '../models')).filter(f => f.endsWith('.js')).map(f => require('../models/' + f));
  const collections = [...new Set([...Object.values(models), ...applicationModels])];
  const issues = [];
  for (const model of collections) {
    for (const [keys, options] of model.schema.indexes()) {
      if (!options.unique) continue;
      const match = options.partialFilterExpression || (options.sparse ? {
        $or: Object.keys(keys).map(k => ({
          [k]: {
            $exists: true
          }
        }))
      } : {});
      const duplicates = await model.aggregate([{
        $match: match
      }, {
        $group: {
          _id: Object.fromEntries(Object.keys(keys).map(k => [k, '$' + k])),
          count: {
            $sum: 1
          }
        }
      }, {
        $match: {
          count: {
            $gt: 1
          }
        }
      }, {
        $limit: 5
      }]);
      if (duplicates.length) issues.push(`${model.modelName}: duplicate ${Object.keys(keys).join(',')}`);
    }
  }
  let wallets = 0;
  for await (const user of User.collection.find({})) {
    try {
      const amount = money(user.wallet?.balance || 0);
      if (user.wallet?.balancePaisa !== undefined && user.wallet.balancePaisa !== amount) issues.push(`Wallet ${user._id}: legacy/paisa mismatch`);else if (user.wallet?.balancePaisa === undefined) wallets++;
    } catch (e) {
      issues.push(`Wallet ${user._id}: invalid precision/balance`);
    }
  }
  const hello = await mongoose.connection.db.admin().command({
    hello: 1
  });
  if (!hello.setName && hello.msg !== 'isdbgrid') issues.push('MongoDB replica set or mongos required');
  console.log(JSON.stringify({
    preflight: issues.length ? 'FAILED' : 'PASSED',
    issues,
    walletsToConvert: wallets
  }, null, 2));
  assert(!issues.length, 'Resolve preflight issues before applying');
  if (!process.argv.includes('--apply')) return;
  // Conversion is conditional on the original balance. Failed comparisons abort instead of overwriting concurrent funds.
  for await (const user of User.collection.find({
    'wallet.balancePaisa': {
      $exists: false
    }
  })) {
    const amount = money(user.wallet?.balance || 0);
    const result = await User.collection.updateOne({
      _id: user._id,
      'wallet.balance': user.wallet?.balance,
      'wallet.balancePaisa': {
        $exists: false
      }
    }, {
      $set: {
        'wallet.balancePaisa': amount
      }
    });
    assert(result.modifiedCount === 1, 'Concurrent wallet update detected; rerun preflight');
  }
  await Driver.updateMany({
    earningsBalancePaisa: {
      $exists: false
    }
  }, {
    $set: {
      earningsBalancePaisa: 0
    }
  });
  await Driver.updateMany({
    cashPayablePaisa: {
      $exists: false
    }
  }, {
    $set: {
      cashPayablePaisa: 0
    }
  });
  for (const model of collections) await model.createIndexes();
  if (process.argv.includes('--seed')) for (const card of require('../pricing/pilot')) await models.RateCard.updateOne({
    city: card.city,
    category: card.category,
    version: card.version
  }, {
    $setOnInsert: card
  }, {
    upsert: true
  });
  await models.PricingAudit.create({
    action: 'MIGRATION_APPLIED',
    entity: 'pricing-v1',
    data: {
      walletsConverted: wallets,
      draftSeed: process.argv.includes('--seed')
    }
  });
  await models.Scope.updateOne({
    _id: 'pricing-v1-ready'
  }, {
    $set: {
      revision: 1
    }
  }, {
    upsert: true
  });
  console.log('Indexes and wallet migration applied. Pilot cards remain DRAFT.');
}
run().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
