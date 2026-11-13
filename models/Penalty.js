const mongoose = require('mongoose');

const penaltySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  subscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscription' // Or CommuteSubscription once created
  },
  amount: {
    type: Number,
    required: true
  },
  reason: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'deducted', 'forgiven'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

penaltySchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('Penalty', penaltySchema);
