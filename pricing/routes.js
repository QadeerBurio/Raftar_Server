const router = require('express').Router();
const {
  assert,
  calculate,
  point
} = require('./math');
const {
  validateCard
} = require('./config');
const {
  RateCard,
  PricingAudit,
  Scope,
  Quote,
  Settlement,
  Ledger
} = require('./models');
const {
  makeQuote,
  transaction
} = require('./service');
const Driver = require('../models/Driver');
router.use(require('../middleware/auth'));
router.use(async (req, res, next) => {
  try {
    await require('./service').assertReady();
    next();
  } catch (e) {
    next(e);
  }
});
router.get('/catalog', async (req, res) => {
  const now = new Date();
  const cards = await RateCard.find({
    status: 'published',
    effectiveFrom: {
      $lte: now
    },
    effectiveTo: {
      $gt: now
    }
  }).lean();
  res.json({
    cards: cards.map(c => ({
      city: c.city,
      category: c.category,
      negotiatedEnabled: c.policy.negotiatedEnabled,
      zone: c.zone,
      version: c.version
    }))
  });
});
router.post('/quotes', async (req, res) => {
  const quote = await makeQuote(req.user.id, req.body);
  res.status(201).json({
    quote
  });
});
router.post('/quotes/:id/offer-preview', async (req, res) => {
  const quote = await Quote.findOne({
    _id: req.params.id,
    owner: req.user.id,
    consumedAt: null,
    expiresAt: {
      $gt: new Date()
    }
  }).lean();
  assert(quote && quote.pricingMode === 'NEGOTIATED', 'Negotiated quote expired or unavailable', 409);
  require('./math').validateOffer(quote.snapshot, req.body.offerPaisa);
  res.json({
    offerPaisa: req.body.offerPaisa,
    breakdown: require('./math').receipt({
      ...quote.snapshot,
      transportFarePaisa: req.body.offerPaisa
    }, {
      passThroughPaisa: quote.snapshot.knownPassThroughPaisa || 0
    })
  });
});
router.delete('/quotes/:id', async (req, res) => {
  const quote = await Quote.findOneAndUpdate({
    _id: req.params.id,
    owner: req.user.id,
    consumedAt: null
  }, {
    $set: {
      expiresAt: new Date()
    }
  }, {
    returnDocument: 'after'
  });
  if (!quote) {
    const existing = await Quote.findOne({
      _id: req.params.id,
      owner: req.user.id
    }).lean();
    assert(existing, 'Quote not found', 404);
    return res.status(409).json({
      error: 'Booking already exists; retry the original booking request',
      rideId: existing.rideId
    });
  }
  res.json({
    discarded: true
  });
});
router.get('/quotes/:id', async (req, res) => {
  const quote = await Quote.findOne({
    _id: req.params.id,
    owner: req.user.id
  });
  assert(quote, 'Quote not found', 404);
  res.json({
    quote
  });
});
router.use('/admin', require('../middleware/roleCheck').isAdmin);
router.get('/admin/cards', async (req, res) => res.json({
  cards: await RateCard.find().sort({
    createdAt: -1
  }).limit(200).lean()
}));
router.post('/admin/cards', async (req, res) => {
  const data = validateCard(req.body);
  const card = await transaction(async session => {
    const [card] = await RateCard.create([{
      ...data,
      status: 'draft'
    }], {
      session
    });
    await PricingAudit.create([{
      actor: req.user.id,
      action: 'DRAFT_CREATED',
      entity: String(card._id),
      data
    }], {
      session
    });
    return card;
  });
  res.status(201).json({
    card
  });
});
router.post('/admin/cards/:id/publish', async (req, res) => {
  const draft = await RateCard.findById(req.params.id).lean();
  assert(draft && draft.status === 'draft', 'Draft required', 409);
  validateCard(draft);
  const scopeId = `${draft.city}:${draft.category}`;
  await Scope.updateOne({
    _id: scopeId
  }, {
    $setOnInsert: {
      revision: 0
    }
  }, {
    upsert: true
  });
  const card = await transaction(async session => {
    await Scope.updateOne({
      _id: scopeId
    }, {
      $inc: {
        revision: 1
      }
    }, {
      session
    });
    const card = await RateCard.findOne({
      _id: draft._id,
      status: 'draft'
    }).session(session);
    assert(card, 'Already published', 409);
    const overlap = await RateCard.findOne({
      city: card.city,
      category: card.category,
      status: 'published',
      effectiveFrom: {
        $lt: card.effectiveTo
      },
      effectiveTo: {
        $gt: card.effectiveFrom
      }
    }).session(session);
    assert(!overlap, 'Published interval overlaps another rate card', 409);
    card.status = 'published';
    card.publishedBy = req.user.id;
    await card.save({
      session
    });
    await PricingAudit.create([{
      actor: req.user.id,
      action: 'RATE_CARD_PUBLISHED',
      entity: String(card._id),
      data: card.toObject()
    }], {
      session
    });
    return card;
  });
  res.json({
    card
  });
});
router.post('/admin/cards/:id/retire', async (req, res) => {
  assert(typeof req.body.reason === 'string' && req.body.reason.length >= 5, 'Retirement reason required');
  const card = await transaction(async session => {
    const card = await RateCard.findById(req.params.id).session(session);
    assert(card?.status === 'published' && card.effectiveTo > new Date(), 'Active or future card required', 409);
    await Scope.updateOne({
      _id: `${card.city}:${card.category}`
    }, {
      $inc: {
        revision: 1
      }
    }, {
      session
    });
    card.effectiveTo = new Date(Math.max(+card.effectiveFrom, Date.now()));
    await card.save({
      session
    });
    await PricingAudit.create([{
      actor: req.user.id,
      action: 'RATE_CARD_RETIRED',
      entity: String(card._id),
      data: {
        reason: req.body.reason,
        effectiveTo: card.effectiveTo
      }
    }], {
      session
    });
    return card;
  });
  res.json({
    card
  });
});
router.post('/admin/simulate', async (req, res) => {
  const card = req.body.card ? validateCard(req.body.card) : await RateCard.findById(req.body.cardId).lean();
  assert(card, 'Card not found', 404);
  res.json({
    normal: calculate(card, req.body.distanceMeters, req.body.durationSeconds, 10000),
    busy: calculate(card, req.body.distanceMeters, req.body.durationSeconds, req.body.multiplierBps || 12500)
  });
});
router.get('/admin/history', async (req, res) => res.json({
  audit: await PricingAudit.find().sort({
    at: -1
  }).limit(200).lean(),
  ledger: await Ledger.find().sort({
    createdAt: -1
  }).limit(200).lean()
}));
router.get('/admin/revenue', async (req, res) => {
  const settled = await Settlement.aggregate([{
    $match: {
      status: 'settled'
    }
  }, {
    $group: {
      _id: '$method',
      passengerTotalPaisa: {
        $sum: '$allocations.passengerTotalPaisa'
      },
      serviceFeePaisa: {
        $sum: '$allocations.serviceFeePaisa'
      },
      commissionPaisa: {
        $sum: '$allocations.commissionPaisa'
      },
      driverEntitlementPaisa: {
        $sum: '$allocations.driverEntitlementPaisa'
      },
      passThroughPaisa: {
        $sum: '$allocations.passThroughPaisa'
      },
      tipPaisa: {
        $sum: '$allocations.tipPaisa'
      },
      refundedPaisa: {
        $sum: '$refundedPaisa'
      },
      refundedPlatformPaisa: {
        $sum: '$refundedAllocations.platformRevenuePaisa'
      },
      refundedDriverPaisa: {
        $sum: '$refundedAllocations.driverEntitlementPaisa'
      }
    }
  }]);
  const drivers = await Driver.find({
    $or: [{
      cashPayablePaisa: {
        $ne: 0
      }
    }, {
      earningsBalancePaisa: {
        $ne: 0
      }
    }]
  }).select('userId earningsBalancePaisa cashPayablePaisa').populate('userId', 'name').limit(200).lean();
  const receivable = await Driver.aggregate([{
    $group: {
      _id: null,
      total: {
        $sum: '$cashPayablePaisa'
      }
    }
  }]);
  res.json({
    settled,
    drivers,
    cashFeeReceivablesPaisa: receivable[0]?.total || 0,
    pending: await Settlement.countDocuments({
      status: 'pending'
    }),
    disputed: await Settlement.countDocuments({
      status: 'disputed'
    })
  });
});
const settlement = require('./settlement');
router.post('/admin/rides/:rideId/refund', settlement.refund);
router.post('/admin/rides/:rideId/cash-refund', settlement.cashRefund);
router.post('/admin/drivers/:driverId/reconcile', settlement.reconcile);
router.post('/admin/rides/:rideId/resolve-cash', async (req, res) => {
  assert(typeof req.body.reason === 'string' && req.body.reason.length >= 5, 'Resolution reason required');
  await transaction(async session => {
    const result = await Settlement.updateOne({
      rideId: req.params.rideId,
      status: 'disputed'
    }, {
      $set: {
        status: 'pending',
        driverConfirmed: false,
        passengerAcknowledged: false
      },
      $inc: {
        ackRevision: 1
      }
    }, {
      session
    });
    assert(result.modifiedCount === 1, 'Disputed settlement required', 409);
    await PricingAudit.create([{
      actor: req.user.id,
      action: 'CASH_DISPUTE_REOPENED',
      entity: req.params.rideId,
      data: {
        reason: req.body.reason
      }
    }], {
      session
    });
  });
  res.json({
    message: 'Both participants must acknowledge cash again'
  });
});
router.post('/admin/cash-refunds/:id/resolve', async (req, res) => {
  assert(typeof req.body.reason === 'string' && req.body.reason.length >= 5, 'Resolution reason required');
  await transaction(async session => {
    const result = await require('./models').CashRefund.updateOne({
      _id: req.params.id,
      status: 'disputed'
    }, {
      $set: {
        status: 'pending',
        driverConfirmed: false,
        passengerAcknowledged: false
      },
      $inc: {
        ackRevision: 1
      }
    }, {
      session
    });
    assert(result.modifiedCount === 1, 'Disputed cash refund required', 409);
    await PricingAudit.create([{
      actor: req.user.id,
      action: 'CASH_REFUND_REOPENED',
      entity: req.params.id,
      data: {
        reason: req.body.reason
      }
    }], {
      session
    });
  });
  res.json({
    message: 'Both participants must acknowledge returned cash again'
  });
});
module.exports = router;
