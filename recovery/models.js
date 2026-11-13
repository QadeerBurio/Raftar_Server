const mongoose = require('mongoose');
const challenge = new mongoose.Schema({
  _id: String,
  account: mongoose.Schema.Types.ObjectId,
  destination: String,
  destinationKey: String,
  purpose: {
    type: String,
    default: 'password-reset'
  },
  otpHash: String,
  tokenHash: String,
  state: {
    type: String,
    default: 'pending'
  },
  attempts: {
    type: Number,
    default: 0
  },
  expiresAt: Date,
  resendAt: Date,
  tokenExpiresAt: Date,
  version: Number,
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  autoIndex: false
});
challenge.index({
  tokenHash: 1
}, {
  unique: true,
  partialFilterExpression: {
    tokenHash: {
      $type: 'string'
    }
  }
});
challenge.index({
  account: 1,
  state: 1
});
const limit = new mongoose.Schema({
  _id: String,
  count: Number,
  expiresAt: Date
}, {
  autoIndex: false
});
limit.index({
  expiresAt: 1
}, {
  expireAfterSeconds: 0
});
const notice = new mongoose.Schema({
  account: mongoose.Schema.Types.ObjectId,
  destination: String,
  status: {
    type: String,
    default: 'pending'
  },
  attempts: {
    type: Number,
    default: 0
  },
  nextAttemptAt: {
    type: Date,
    default: Date.now
  },
  leaseUntil: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  autoIndex: false
});
notice.index({
  status: 1,
  nextAttemptAt: 1
});
const Notice = mongoose.model('RecoveryNotice', notice);
module.exports = {
  Notice,
  Challenge: mongoose.model('RecoveryChallenge', challenge),
  Limit: mongoose.model('RecoveryLimit', limit)
};
