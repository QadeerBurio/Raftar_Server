const {
  Notice
} = require('./models');
const provider = require('./provider');
exports.deliver = async id => {
  const now = new Date();
  const notice = await Notice.findOneAndUpdate({
    _id: id,
    status: 'pending',
    nextAttemptAt: {
      $lte: now
    },
    $or: [{
      leaseUntil: null
    }, {
      leaseUntil: {
        $lte: now
      }
    }]
  }, {
    $set: {
      leaseUntil: new Date(Date.now() + 30000)
    },
    $inc: {
      attempts: 1
    }
  }, {
    returnDocument: 'after'
  });
  if (!notice) return false;
  try {
    await provider.send(notice.destination, 'Your Raftar password was changed. If this was not you, contact support immediately.');
    await Notice.updateOne({
      _id: id
    }, {
      $set: {
        status: 'delivered'
      },
      $unset: {
        leaseUntil: 1
      }
    });
    return true;
  } catch (e) {
    await Notice.updateOne({
      _id: id
    }, {
      $set: {
        status: notice.attempts >= 5 ? 'failed' : 'pending',
        nextAttemptAt: new Date(Date.now() + 60000)
      },
      $unset: {
        leaseUntil: 1
      }
    });
    console.warn('Password-changed notification delivery failed; retry recorded');
    return false;
  }
};
exports.start = () => require('node-cron').schedule('*/30 * * * * *', async () => {
  if (require('mongoose').connection.readyState !== 1 || !provider.available()) return;
  try {
    const pending = await Notice.find({
      status: 'pending',
      nextAttemptAt: {
        $lte: new Date()
      }
    }).limit(50).select('_id');
    for (const n of pending) await exports.deliver(n._id);
  } catch (e) {
    console.warn('Recovery notification retry unavailable');
  }
});
