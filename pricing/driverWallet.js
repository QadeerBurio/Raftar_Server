const {
  Driver,
  Payment,
  Ledger
} = {
  Driver: require('../models/Driver'),
  Payment: require('../models/Payment'),
  Ledger: require('./models').Ledger
};
const {
  assert,
  money
} = require('./math');
const {
  transaction
} = require('./service');
exports.withdraw = async (req, res) => {
  const amountPaisa = money(req.body.amount);
  assert(amountPaisa > 0, 'Positive withdrawal amount required');
  const k = req.get('Idempotency-Key');
  assert(/^[a-zA-Z0-9:_-]{8,120}$/.test(k || ''), 'Withdrawal Idempotency-Key required');
  const key = `driver-withdraw:${req.user.id}:${k}`;
  const withdrawal = await transaction(async session => {
    const existing = await Ledger.findOne({
      key
    }).session(session);
    if (existing) {
      assert(existing.allocations.amountPaisa === amountPaisa, 'Idempotency mismatch', 409);
      return Payment.findById(existing.metadata.paymentId).session(session);
    }
    const driver = await Driver.findOneAndUpdate({
      userId: req.user.id,
      earningsBalancePaisa: {
        $gte: amountPaisa
      }
    }, {
      $inc: {
        earningsBalancePaisa: -amountPaisa
      }
    }, {
      new: true,
      session
    });
    assert(driver, 'Insufficient settled driver earnings', 409);
    const [payment] = await Payment.create([{
      userId: req.user.id,
      amount: amountPaisa / 100,
      amountPaisa,
      type: 'withdrawal',
      paymentMethod: 'bank_transfer',
      status: 'pending',
      metadata: {
        ledgerAccount: 'driver_earnings',
        driverId: String(driver._id),
        bankAccount: req.body.bankAccount || '',
        bankName: req.body.bankName || '',
        accountHolder: req.body.accountHolder || ''
      }
    }], {
      session
    });
    await Ledger.create([{
      key,
      actor: req.user.id,
      kind: 'DRIVER_WITHDRAWAL_HOLD',
      allocations: {
        amountPaisa
      },
      metadata: {
        paymentId: String(payment._id),
        driverId: String(driver._id)
      }
    }], {
      session
    });
    return payment;
  });
  res.json({
    success: true,
    withdrawal,
    message: 'Settled earnings held for bank payout review'
  });
};
