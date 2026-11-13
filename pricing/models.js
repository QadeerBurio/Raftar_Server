const mongoose = require('mongoose');
const {
  Schema
} = mongoose;
const mixed = Schema.Types.Mixed;
function model(name, fields, indexes = [], appendOnly = false, options = {}) {
  const schema = new Schema(fields, {
    autoIndex: false,
    ...options
  });
  for (const [keys, opts] of indexes) schema.index(keys, opts || {});
  if (appendOnly) {
    schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
      throw new Error(name + ' is append-only');
    });
    schema.pre('save', function () {
      if (!this.isNew) throw new Error(name + ' is append-only');
    });
  }
  return mongoose.model(name, schema);
}
const RateCard = model('RateCard', {
  city: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['bike', 'rickshaw', 'economy', 'comfort'],
    required: true
  },
  version: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['draft', 'published'],
    default: 'draft'
  },
  effectiveFrom: {
    type: Date,
    required: true
  },
  effectiveTo: {
    type: Date,
    required: true
  },
  rates: {
    type: mixed,
    required: true
  },
  policy: {
    type: mixed,
    required: true
  },
  zone: {
    type: mixed,
    required: true
  },
  publishedBy: Schema.Types.ObjectId
}, [[{
  city: 1,
  category: 1,
  version: 1
}, {
  unique: true
}]], false, {
  timestamps: true
});
const Quote = model('PricingQuote', {
  owner: {
    type: Schema.Types.ObjectId,
    required: true,
    immutable: true
  },
  route: {
    type: mixed,
    immutable: true
  },
  snapshot: {
    type: mixed,
    immutable: true
  },
  pricingMode: String,
  expiresAt: Date,
  consumedAt: Date,
  rideId: Schema.Types.ObjectId
}, [[{
  owner: 1,
  createdAt: -1
}]], false, {
  timestamps: true
});
const PricingAudit = model('PricingAudit', {
  actor: Schema.Types.ObjectId,
  action: String,
  entity: String,
  data: mixed,
  at: {
    type: Date,
    default: Date.now
  }
}, [], true);
const Scope = model('PricingScope', {
  _id: String,
  revision: {
    type: Number,
    default: 0
  }
});
const SurgeState = model('PricingSurgeState', {
  _id: String,
  multiplierBps: Number,
  changedAt: Date,
  sampledAt: Date
});
const Offer = model('PricingOffer', {
  rideId: {
    type: Schema.Types.ObjectId,
    required: true
  },
  driverId: {
    type: Schema.Types.ObjectId,
    required: true
  },
  amountPaisa: Number,
  expiresAt: Date,
  status: {
    type: String,
    default: 'active'
  }
}, [[{
  rideId: 1,
  driverId: 1
}, {
  unique: true
}]], false, {
  timestamps: true
});
const Settlement = model('RideSettlement', {
  rideId: {
    type: Schema.Types.ObjectId,
    required: true
  },
  passengerId: Schema.Types.ObjectId,
  driverId: Schema.Types.ObjectId,
  method: {
    type: String,
    enum: ['wallet', 'cash']
  },
  status: {
    type: String,
    enum: ['pending', 'disputed', 'settled'],
    default: 'pending'
  },
  driverConfirmed: Boolean,
  passengerAcknowledged: Boolean,
  ackRevision: {
    type: Number,
    default: 0
  },
  allocations: mixed,
  refundedPaisa: {
    type: Number,
    default: 0
  },
  refundedAllocations: mixed,
  createdAt: {
    type: Date,
    default: Date.now
  }
}, [[{
  rideId: 1
}, {
  unique: true
}]]);
const Ledger = model('PricingLedger', {
  key: {
    type: String,
    required: true
  },
  rideId: Schema.Types.ObjectId,
  actor: Schema.Types.ObjectId,
  kind: String,
  receiptReference: String,
  allocations: mixed,
  metadata: mixed,
  createdAt: {
    type: Date,
    default: Date.now
  }
}, [[{
  key: 1
}, {
  unique: true
}], [{
  receiptReference: 1
}, {
  unique: true,
  partialFilterExpression: {
    receiptReference: {
      $type: 'string'
    }
  }
}]], true);
const CashRefund = model('PricingCashRefund', {
  rideId: Schema.Types.ObjectId,
  key: String,
  amountPaisa: Number,
  reason: String,
  driverConfirmed: Boolean,
  passengerAcknowledged: Boolean,
  ackRevision: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'disputed', 'completed']
  }
}, [[{
  rideId: 1,
  key: 1
}, {
  unique: true
}]]);
module.exports = {
  RateCard,
  Quote,
  PricingAudit,
  Scope,
  SurgeState,
  Offer,
  Settlement,
  Ledger,
  CashRefund
};
