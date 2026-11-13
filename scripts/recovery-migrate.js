const mongoose = require('mongoose');
(async () => {
  if (!process.env.RECOVERY_MIGRATION_URI) throw Error('Set RECOVERY_MIGRATION_URI explicitly');
  await mongoose.connect(process.env.RECOVERY_MIGRATION_URI, {
    serverSelectionTimeoutMS: 8000,
    autoIndex: false
  });
  const hello = await mongoose.connection.db.admin().command({
    hello: 1
  });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw Error('Recovery requires a MongoDB replica set for atomic reset operations');
  const {
    Challenge,
    Limit,
    Notice
  } = require('../recovery/models');
  const duplicates = await Challenge.aggregate([{
    $match: {
      tokenHash: {
        $type: 'string'
      }
    }
  }, {
    $group: {
      _id: '$tokenHash',
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
    $limit: 1
  }]);
  if (duplicates.length) throw Error('Duplicate recovery token hashes detected; review data before indexing');
  await Challenge.createIndexes();
  await Limit.createIndexes();
  await Notice.createIndexes();
  console.log('Recovery indexes installed; no account verification or passwords changed.');
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
