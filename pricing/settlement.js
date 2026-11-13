const mongoose = require('mongoose');
const {
  Settlement,
  Ledger
} = require('./models');
const Ride = require('../models/Ride');
const User = require('../models/User');
const Driver = require('../models/Driver');
const Payment = require('../models/Payment');
const {
  assert,
  integer,
  halfUp
} = require('./math');
const {
  transaction
} = require('./service');
function checkReceipt(r) {
  assert(r && Number.isSafeInteger(r.passengerTotalPaisa) && r.passengerTotalPaisa > 0 && r.driverEntitlementPaisa + r.platformRevenuePaisa === r.passengerTotalPaisa, 'Valid immutable receipt required', 409);
}
async function allocations(ride, method, session, actor) {
  const r = ride.receipt;
  checkReceipt(r);
  const existing = await Settlement.findOne({
    rideId: ride._id
  }).session(session);
  if (existing?.status === 'settled') {
    assert(existing.method === method, 'Ride settled using another method', 409);
    return existing;
  }
  assert(!existing || existing.method === method, 'Settlement method already selected', 409);
  if (method === 'wallet') {
    const user = await User.findOneAndUpdate({
      _id: ride.passengerId,
      'wallet.balancePaisa': {
        $gte: r.passengerTotalPaisa
      }
    }, {
      $inc: {
        'wallet.balancePaisa': -r.passengerTotalPaisa,
        'wallet.balance': -r.passengerTotalPaisa / 100
      }
    }, {
      new: true,
      session
    });
    assert(user, 'Insufficient wallet balance or wallet migration required', 409);
    const credit = await Driver.updateOne({
      _id: ride.driverId
    }, {
      $inc: {
        earningsBalancePaisa: r.driverEntitlementPaisa,
        'stats.totalEarnings': r.driverEntitlementPaisa / 100
      }
    }, {
      session
    });
    assert(credit.matchedCount === 1, 'Driver account missing', 409);
  } else {
    assert(existing?.driverConfirmed && existing?.passengerAcknowledged && existing.status !== 'disputed', 'Cash acknowledgement pending', 409);
    // Cash is held by driver; the platform has a receivable, not cash income.
    const credit = await Driver.updateOne({
      _id: ride.driverId
    }, {
      $inc: {
        cashPayablePaisa: r.platformRevenuePaisa,
        'stats.totalEarnings': r.driverEntitlementPaisa / 100
      }
    }, {
      session
    });
    assert(credit.matchedCount === 1, 'Driver account missing', 409);
  }
  const settled = await Settlement.findOneAndUpdate({
    rideId: ride._id
  }, {
    $set: {
      passengerId: ride.passengerId,
      driverId: ride.driverId,
      method,
      status: 'settled',
      allocations: r
    }
  }, {
    upsert: true,
    new: true,
    session
  });
  await Ledger.create([{
    key: `settle:${ride._id}`,
    rideId: ride._id,
    actor,
    kind: method === 'cash' ? 'CASH_RECEIVABLE' : 'WALLET_SETTLEMENT',
    allocations: r
  }], {
    session
  });
  const [payment] = await Payment.create([{
    userId: ride.passengerId,
    rideId: ride._id,
    amount: r.passengerTotalPaisa / 100,
    amountPaisa: r.passengerTotalPaisa,
    currency: 'PKR',
    type: 'ride',
    paymentMethod: method,
    status: 'completed',
    completedAt: new Date(),
    metadata: {
      pricingSettlement: String(settled._id)
    }
  }], {
    session
  });
  ride.payment = {
    method,
    status: 'paid',
    amount: r.passengerTotalPaisa / 100,
    transactionId: String(payment._id)
  };
  await ride.save({
    session
  });
  return settled;
}
exports.settle = async (req, res) => {
  await require('./service').assertReady();
  const result = await transaction(async session => {
    const ride = await Ride.findOne({
      _id: req.body.rideId,
      passengerId: req.user.id
    }).session(session);
    assert(ride?.pricing, 'Priced ride not found', 404);
    assert(ride.status === 'completed', 'Only completed rides can settle', 409);
    assert(req.body.paymentMethod === 'wallet', 'External settlement is not implemented; use authenticated cash acknowledgements', 501);
    assert(!req.body.amount && !req.body.fare, 'Payment amounts must not be supplied by client');
    return allocations(ride, 'wallet', session, req.user.id);
  });
  res.json({
    success: true,
    settlement: result
  });
};
exports.cash = async (req, res) => {
  const result = await transaction(async session => {
    const ride = await Ride.findById(req.params.rideId).session(session);
    assert(ride?.pricing && ride.status === 'completed', 'Completed priced ride required', 409);
    checkReceipt(ride.receipt);
    const driver = await Driver.findOne({
      _id: ride.driverId,
      userId: req.user.id
    }).session(session);
    const passenger = String(ride.passengerId) === String(req.user.id);
    assert(driver || passenger, 'Ride participant required', 403);
    let settlement = await Settlement.findOne({
      rideId: ride._id
    }).session(session);
    if (settlement?.status === 'settled') return settlement;
    assert(!settlement || settlement.method === 'cash', 'Different settlement pending', 409);
    assert(req.body.amountPaisa === ride.receipt.passengerTotalPaisa, 'Confirm the full disclosed cash total');
    const dispute = req.body.disputed === true;
    assert(!settlement || settlement.status !== 'disputed', 'Cash is disputed; admin resolution required', 409);
    if (!settlement) settlement = new Settlement({
      rideId: ride._id,
      passengerId: ride.passengerId,
      driverId: ride.driverId,
      method: 'cash',
      allocations: ride.receipt
    });
    if (!dispute && (driver && settlement.driverConfirmed || passenger && settlement.passengerAcknowledged)) return settlement;
    if (dispute) settlement.status = 'disputed';else if (driver) settlement.driverConfirmed = true;else settlement.passengerAcknowledged = true;
    await settlement.save({
      session
    });
    await Ledger.create([{
      key: `cash-ack:${ride._id}:${settlement.ackRevision || 0}:${req.user.id}:${dispute ? 'dispute' : 'confirm'}`,
      rideId: ride._id,
      actor: req.user.id,
      kind: 'CASH_ACKNOWLEDGEMENT',
      metadata: {
        disputed: dispute,
        amountPaisa: req.body.amountPaisa
      }
    }], {
      session
    });
    if (settlement.driverConfirmed && settlement.passengerAcknowledged && settlement.status !== 'disputed') return allocations(ride, 'cash', session, req.user.id);
    return settlement;
  });
  res.json({
    success: true,
    settlement: result
  });
};
function cumulativeRefund(original, amount) {
  checkReceipt(original);
  integer(amount, 'refund');
  assert(amount <= original.passengerTotalPaisa, 'Refund exceeds payment');
  const r = {};
  for (const field of ['transportFarePaisa', 'waitingPaisa', 'eligibleFarePaisa', 'serviceFeePaisa', 'commissionPaisa', 'passThroughPaisa', 'tipPaisa']) r[field] = halfUp(BigInt(original[field] || 0) * BigInt(amount), original.passengerTotalPaisa);
  r.passengerTotalPaisa = amount;
  r.platformRevenuePaisa = halfUp(BigInt(original.platformRevenuePaisa) * BigInt(amount), original.passengerTotalPaisa);
  r.commissionPaisa = r.platformRevenuePaisa - r.serviceFeePaisa;
  r.driverEntitlementPaisa = amount - r.platformRevenuePaisa;
  return r;
}
exports.cumulativeRefund = cumulativeRefund;
exports.refund = async (req, res) => {
  assert(req.user.role === 'admin', 'Admin required', 403);
  integer(req.body.amountPaisa, 'refund amount');
  assert(req.body.amountPaisa > 0 && typeof req.body.reason === 'string' && req.body.reason.length >= 5, 'Refund amount and reason required');
  const requestKey = req.get('Idempotency-Key');
  assert(/^[a-zA-Z0-9:_-]{8,120}$/.test(requestKey || ''), 'Refund Idempotency-Key required');
  const result = await transaction(async session => {
    const existing = await Ledger.findOne({
      key: `refund:${req.params.rideId}:${requestKey}`
    }).session(session);
    if (existing) {
      assert(existing.allocations.passengerTotalPaisa === req.body.amountPaisa, 'Idempotency payload mismatch', 409);
      return existing;
    }
    const settlement = await Settlement.findOne({
      rideId: req.params.rideId,
      status: 'settled'
    }).session(session);
    assert(settlement, 'Settled ride required', 409);
    assert(settlement.method === 'wallet', 'Cash refunds require driver return confirmation and passenger acknowledgement via cash refund workflow', 501);
    return reverse(settlement, req.body.amountPaisa, `refund:${req.params.rideId}:${requestKey}`, req.user.id, req.body.reason, session);
  });
  res.json({
    success: true,
    refund: result
  });
};
async function reverse(settlement, amount, key, actor, reason, session) {
  const total = settlement.refundedPaisa + amount;
  const cumulative = cumulativeRefund(settlement.allocations, total);
  const before = settlement.refundedAllocations || {};
  const delta = {};
  for (const k of Object.keys(cumulative)) delta[k] = cumulative[k] - (before[k] || 0);
  if (settlement.method === 'wallet') {
    const refunded = await User.updateOne({
      _id: settlement.passengerId
    }, {
      $inc: {
        'wallet.balancePaisa': amount,
        'wallet.balance': amount / 100
      }
    }, {
      session
    });
    assert(refunded.matchedCount === 1, 'Passenger refund account missing', 409);
    const reversed = await Driver.updateOne({
      _id: settlement.driverId
    }, {
      $inc: {
        earningsBalancePaisa: -delta.driverEntitlementPaisa,
        'stats.totalEarnings': -delta.driverEntitlementPaisa / 100
      }
    }, {
      session
    });
    assert(reversed.matchedCount === 1, 'Driver reversal account missing', 409);
  } else {
    const reversed = await Driver.updateOne({
      _id: settlement.driverId
    }, {
      $inc: {
        cashPayablePaisa: -delta.platformRevenuePaisa,
        'stats.totalEarnings': -delta.driverEntitlementPaisa / 100
      }
    }, {
      session
    });
    assert(reversed.matchedCount === 1, 'Driver reversal account missing', 409);
  }
  settlement.refundedPaisa = total;
  settlement.refundedAllocations = cumulative;
  await settlement.save({
    session
  });
  const [entry] = await Ledger.create([{
    key,
    rideId: settlement.rideId,
    actor,
    kind: 'REFUND_REVERSAL',
    allocations: delta,
    metadata: {
      reason,
      method: settlement.method
    }
  }], {
    session
  });
  if (total === settlement.allocations.passengerTotalPaisa) await Payment.updateMany({
    rideId: settlement.rideId,
    type: 'ride',
    status: 'completed'
  }, {
    $set: {
      status: 'refunded',
      refundedAt: new Date()
    }
  }, {
    session
  });
  return entry;
}
// Cash refunds are proposals. No reversal occurs until both parties attest that cash was returned.
exports.cashRefund = async (req, res) => {
  const result = await transaction(async session => {
    const settlement = await Settlement.findOne({
      rideId: req.params.rideId,
      status: 'settled',
      method: 'cash'
    }).session(session);
    assert(settlement, 'Settled cash ride required', 409);
    const driver = await Driver.findOne({
      _id: settlement.driverId,
      userId: req.user.id
    }).session(session);
    const passenger = String(settlement.passengerId) === String(req.user.id);
    assert(driver || passenger || req.user.role === 'admin', 'Ride participant or admin required', 403);
    const scope = await require('./models').Scope.findOneAndUpdate({
      _id: `cash-refund:${settlement.rideId}`
    }, {
      $inc: {
        revision: 1
      }
    }, {
      upsert: true,
      new: true,
      session
    });
    assert(scope, 'Cash refund lock unavailable');
    const refundKey = req.body.refundKey;
    assert(/^[a-zA-Z0-9:_-]{8,120}$/.test(refundKey || ''), 'refundKey required');
    const ledgerKey = `cash-refund:${settlement.rideId}:${refundKey}`;
    const completed = await Ledger.findOne({
      key: ledgerKey
    }).session(session);
    if (completed) return completed;
    const intents = require('./models').CashRefund;
    let intent = await intents.findOne({
      rideId: settlement.rideId,
      key: refundKey
    }).session(session);
    if (!intent) {
      assert(req.user.role === 'admin', 'Admin must initiate a cash refund', 403);
      const reserved = await intents.aggregate([{
        $match: {
          rideId: settlement.rideId,
          status: {
            $in: ['pending', 'disputed']
          }
        }
      }, {
        $group: {
          _id: null,
          total: {
            $sum: '$amountPaisa'
          }
        }
      }]).session(session);
      assert((reserved[0]?.total || 0) + settlement.refundedPaisa + req.body.amountPaisa <= settlement.allocations.passengerTotalPaisa, 'Refund exceeds unreserved original payment', 409);
      integer(req.body.amountPaisa);
      assert(req.body.amountPaisa > 0 && req.body.amountPaisa + settlement.refundedPaisa <= settlement.allocations.passengerTotalPaisa && typeof req.body.reason === 'string' && req.body.reason.length >= 5, 'Valid refund amount/reason required');
      intent = new intents({
        rideId: settlement.rideId,
        key: refundKey,
        amountPaisa: req.body.amountPaisa,
        reason: req.body.reason,
        status: 'pending'
      });
    } else {
      if (req.user.role === 'admin') {
        assert(intent.amountPaisa === req.body.amountPaisa, 'Refund idempotency mismatch', 409);
        return intent;
      }
      if (!req.body.disputed && (driver && intent.driverConfirmed || passenger && intent.passengerAcknowledged)) return intent;
      assert(driver || passenger, 'Participant acknowledgement required', 403);
      assert(intent.status === 'pending', 'Refund disputed', 409);
      if (req.body.disputed) intent.status = 'disputed';else if (driver) intent.driverConfirmed = true;else intent.passengerAcknowledged = true;
    }
    await intent.save({
      session
    });
    await Ledger.create([{
      key: `${ledgerKey}:ack:${intent.ackRevision || 0}:${req.user.id}:${req.body.disputed ? 'dispute' : 'confirm'}`,
      rideId: settlement.rideId,
      actor: req.user.id,
      kind: 'CASH_REFUND_ACK',
      metadata: {
        amountPaisa: intent.amountPaisa,
        status: intent.status
      }
    }], {
      session
    });
    if (intent.driverConfirmed && intent.passengerAcknowledged && intent.status === 'pending') {
      const entry = await reverse(settlement, intent.amountPaisa, ledgerKey, req.user.id, intent.reason, session);
      intent.status = 'completed';
      await intent.save({
        session
      });
      return entry;
    }
    return intent;
  });
  res.json({
    refund: result
  });
};
exports.reconcile = async (req, res) => {
  assert(req.user.role === 'admin', 'Admin required', 403);
  const k = req.get('Idempotency-Key');
  assert(/^[a-zA-Z0-9:_-]{8,120}$/.test(k || ''), 'Idempotency-Key required');
  integer(req.body.amountPaisa);
  assert(req.body.amountPaisa > 0 && typeof req.body.reference === 'string' && req.body.reference.length >= 5, 'Amount and verified bank receipt reference required');
  const result = await transaction(async session => {
    const existing = await Ledger.findOne({
      $or: [{
        key: `reconcile:${req.params.driverId}:${k}`
      }, {
        receiptReference: req.body.reference
      }]
    }).session(session);
    if (existing) {
      assert(existing.allocations?.amountPaisa === req.body.amountPaisa && existing.metadata?.driverId === req.params.driverId && existing.receiptReference === req.body.reference, 'Idempotency or bank receipt mismatch', 409);
      return existing;
    }
    const driver = await Driver.findOneAndUpdate({
      _id: req.params.driverId,
      cashPayablePaisa: {
        $gte: req.body.amountPaisa
      }
    }, {
      $inc: {
        cashPayablePaisa: -req.body.amountPaisa
      }
    }, {
      new: true,
      session
    });
    assert(driver, 'Amount exceeds driver cash payable', 409);
    const [entry] = await Ledger.create([{
      key: `reconcile:${req.params.driverId}:${k}`,
      actor: req.user.id,
      kind: 'CASH_FEE_RECONCILIATION',
      receiptReference: req.body.reference,
      allocations: {
        amountPaisa: req.body.amountPaisa
      },
      metadata: {
        driverId: req.params.driverId,
        reference: req.body.reference
      }
    }], {
      session
    });
    return entry;
  });
  res.json({
    entry: result
  });
};
