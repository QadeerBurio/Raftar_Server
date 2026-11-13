const crypto = require('crypto');
const Ride = require('../models/Ride');
const Driver = require('../models/Driver');
const {
  Quote,
  Offer,
  PricingAudit
} = require('./models');
const {
  assert,
  integer,
  point,
  categoryVehicles,
  receipt,
  validateOffer
} = require('./math');
const {
  transaction
} = require('./service');
const {
  sendNotification
} = require('../services/notificationService');
const emit = (req, ride, event, data = {}) => req.app.get('io')?.to(`ride-${ride._id}`).emit(event, {
  ride,
  rideId: ride._id,
  ...data
});
const notify = async (req, ride, event, data = {}) => {
  emit(req, ride, event, data);
  await sendNotification(ride.passengerId, 'system', {
    title: event.replaceAll('-', ' '),
    body: data.message || 'Your Raftar ride has been updated.',
    rideId: String(ride._id)
  });
};
const owned = async (req, session) => {
  const ride = await Ride.findById(req.params.rideId).session(session || null);
  assert(ride?.pricing, 'Priced ride not found', 404);
  const driver = await Driver.findOne({
    userId: req.user.id
  }).session(session || null);
  return {
    ride,
    driver,
    passenger: String(ride.passengerId) === String(req.user.id),
    assigned: driver && String(ride.driverId) === String(driver._id)
  };
};
const key = req => {
  const k = req.get('Idempotency-Key');
  assert(typeof k === 'string' && /^[a-zA-Z0-9:_-]{8,120}$/.test(k), 'Idempotency-Key header required (8-120 letters/digits/dashes)');
  return `${req.user.id}:${k}`;
};
const waitingSeconds = ride => ride.pickupWaiting?.authorized && ride.pickupWaiting.arrivedAt ? Math.max(0, Math.floor((+(ride.pickupWaiting.endedAt || new Date()) - +ride.pickupWaiting.arrivedAt) / 1000)) : 0;
function finalReceipt(ride) {
  const adjustments = (ride.adjustments || []).filter(a => a.status === 'approved');
  const passThroughPaisa = adjustments.filter(a => a.kind === 'passThrough').reduce((s, a) => s + a.amountPaisa, 0);
  const tipPaisa = adjustments.filter(a => a.kind === 'tip').reduce((s, a) => s + a.amountPaisa, 0);
  return receipt(ride.pricing, {
    waitingSeconds: waitingSeconds(ride),
    passThroughPaisa,
    tipPaisa
  });
}
exports.book = async (req, res) => {
  await require('./service').assertReady();
  const bookingKey = key(req);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical(req.body))).digest('hex');
  let ride;
  try {
    ride = await transaction(async session => {
      const existing = await Ride.findOne({
        bookingKey
      }).session(session);
      if (existing) {
        assert(existing.bookingFingerprint === fingerprint, 'Idempotency request payload changed', 409);
        assert(String(existing.quoteId) === String(req.body.quoteId), 'Idempotency key belongs to a different booking', 409);
        if (existing.originalPricing.pricingMode === 'NEGOTIATED') assert(existing.originalPricing.transportFarePaisa === req.body.offerPaisa, 'Idempotency offer mismatch', 409);
        return existing;
      }
      assert(process.env.PRICING_NEW_BOOKINGS_ENABLED !== 'false', 'New bookings are temporarily disabled', 503);
      const quote = await Quote.findOne({
        _id: req.body.quoteId,
        owner: req.user.id,
        expiresAt: {
          $gt: new Date()
        },
        consumedAt: null
      }).session(session);
      assert(quote, 'Quote expired, consumed, or not owned by you. Refresh the quote.', 409);
      if (req.body.category) assert(req.body.category === quote.snapshot.category, 'Quote category mismatch');
      for (const field of ['pickup', 'dropoff']) if (req.body[field]) assert(JSON.stringify(point(req.body[field]).location.coordinates) === JSON.stringify(quote.route[field].location.coordinates), 'Route changed: refresh quote');
      if (req.body.waypoints) assert(JSON.stringify(req.body.waypoints.map(p => point(p).location.coordinates)) === JSON.stringify(quote.route.stops.map(p => p.location.coordinates)), 'Stops changed: refresh quote');
      assert(!req.body.fare && !req.body.surge && !req.body.distance && !req.body.serviceFee, 'Client-calculated pricing is not accepted');
      const pricing = structuredClone(quote.snapshot);
      if (quote.pricingMode === 'NEGOTIATED') {
        validateOffer(pricing, req.body.offerPaisa);
        pricing.transportFarePaisa = req.body.offerPaisa;
        pricing.breakdown = receipt(pricing, {
          passThroughPaisa: pricing.knownPassThroughPaisa || 0
        });
      }
      const [created] = await Ride.create([{
        passengerId: req.user.id,
        quoteId: quote._id,
        bookingKey,
        bookingFingerprint: fingerprint,
        type: req.body.type === 'intercity' ? 'intercity' : 'solo',
        pickup: quote.route.pickup,
        dropoff: quote.route.dropoff,
        waypoints: quote.route.stops,
        vehicleType: categoryVehicles[pricing.category],
        pricing,
        originalPricing: pricing,
        pricingHistory: [],
        adjustments: pricing.knownPassThroughPaisa ? [{
          id: crypto.randomUUID(),
          kind: 'passThrough',
          chargeType: 'toll',
          status: 'approved',
          autoKnown: true,
          amountPaisa: pricing.knownPassThroughPaisa,
          evidence: 'Google Routes road toll estimate in accepted quote',
          approvedBy: String(req.user.id),
          approvedAt: new Date().toISOString()
        }] : [],
        receipt: pricing.breakdown,
        fare: {
          accepted: pricing.transportFarePaisa / 100,
          offered: pricing.transportFarePaisa / 100,
          type: quote.pricingMode === 'NEGOTIATED' ? 'offer' : 'ai'
        },
        status: 'searching',
        guest: req.body.guest
      }], {
        session
      });
      const consumed = await Quote.updateOne({
        _id: quote._id,
        consumedAt: null
      }, {
        $set: {
          consumedAt: new Date(),
          rideId: created._id
        }
      }, {
        session
      });
      assert(consumed.modifiedCount === 1, 'Quote already consumed', 409);
      return created;
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    ride = await Ride.findOne({
      bookingKey
    });
    assert(ride && String(ride.quoteId) === String(req.body.quoteId) && ride.bookingFingerprint === fingerprint, 'Quote consumed or idempotency payload changed', 409);
  }
  req.app.get('io')?.emit('new-ride-request', ride);
  res.status(201).json({
    success: true,
    ride
  });
};
async function verifyEligible(driver, ride, session) {
  assert(driver && ['approved', 'active'].includes(driver.status) && driver.isOnline && driver.availability.status === 'available' && !driver.currentRide && !driver.currentParcel && driver.vehicleDetails.type === categoryVehicles[ride.pricing.category], 'Driver unavailable', 409);
  assert(await require('../models/User').exists({
    _id: driver.userId,
    isActive: true
  }).session(session), 'Driver account inactive', 409);
  assert(!(await Ride.exists({
    driverId: driver._id,
    status: {
      $in: ['accepted', 'started']
    }
  }).session(session)), 'Driver has an active trip', 409);
  const freshness = ride.pricing.policy.surge.freshnessSeconds * 1000;
  assert(driver.locationUpdatedAt && Date.now() - driver.locationUpdatedAt <= freshness && Date.now() - driver.availability.lastUpdated <= freshness, 'Fresh idle driver heartbeat required', 409);
  const zone = ride.pricing.zone || (await require('./models').RateCard.findById(ride.pricing.rateCardId).session(session)).zone;
  assert(require('./math').inside(driver.location.coordinates, zone.coordinates[0]), 'Driver outside service zone', 409);
  assert((driver.cashPayablePaisa || 0) <= ride.pricing.policy.cashPayableLimitPaisa, 'Settle outstanding cash fees before accepting another ride', 409);
}
async function eligibleDriver(req, ride, session) {
  const driver = await Driver.findOne({
    userId: req.user.id,
    status: {
      $in: ['approved', 'active']
    },
    isOnline: true,
    currentRide: null,
    currentParcel: null,
    'availability.status': 'available',
    'vehicleDetails.type': categoryVehicles[ride.pricing.category]
  }).session(session);
  assert(driver && String(ride.passengerId) !== String(req.user.id), 'Eligible idle driver required', 403);
  assert((driver.cashPayablePaisa || 0) <= ride.pricing.policy.cashPayableLimitPaisa, 'Settle outstanding cash fees before accepting another ride', 409);
  await verifyEligible(driver, ride, session);
  return driver;
}
exports.offer = async (req, res) => {
  const result = await transaction(async session => {
    const ride = await Ride.findById(req.params.rideId).session(session);
    assert(ride?.pricing?.pricingMode === 'NEGOTIATED' && ride.status === 'searching', 'Ride is not accepting offers', 409);
    const driver = await eligibleDriver(req, ride, session);
    const amount = req.body.amountPaisa ?? (req.body.amount !== undefined ? require('./math').money(req.body.amount) : ride.pricing.transportFarePaisa);
    validateOffer(ride.originalPricing, amount);
    // Serialize offer changes with simultaneous selection via the ride document.
    await Ride.updateOne({
      _id: ride._id,
      status: 'searching'
    }, {
      $inc: {
        pricingRevision: 1
      }
    }, {
      session
    });
    const offer = await Offer.findOneAndUpdate({
      rideId: ride._id,
      driverId: driver._id
    }, {
      $set: {
        amountPaisa: amount,
        status: 'active',
        expiresAt: new Date(Date.now() + ride.pricing.policy.offerLifetimeSeconds * 1000)
      }
    }, {
      upsert: true,
      new: true,
      session
    });
    await PricingAudit.create([{
      actor: req.user.id,
      action: 'DRIVER_OFFER',
      entity: String(ride._id),
      data: {
        driverId: driver._id,
        amountPaisa: amount,
        expiresAt: offer.expiresAt
      }
    }], {
      session
    });
    const preview = {
      ...ride.pricing,
      transportFarePaisa: amount
    };
    return {
      offer,
      breakdown: receipt(preview, {
        passThroughPaisa: ride.pricing.knownPassThroughPaisa || 0
      }),
      ride
    };
  });
  emit(req, result.ride, 'counter-offer', {
    offer: result.offer,
    amount: result.offer.amountPaisa / 100,
    driverId: result.offer.driverId,
    breakdown: result.breakdown
  });
  res.json(result);
};
async function select(req, offerId) {
  return transaction(async session => {
    const {
      ride,
      driver,
      passenger,
      assigned
    } = await owned(req, session);
    if (offerId && passenger && String(ride.selectedOfferId) === String(offerId)) return ride;
    if (!offerId && assigned && ['accepted', 'started', 'completed'].includes(ride.status)) return ride;
    assert(ride.status === 'searching', 'Ride already assigned', 409);
    let selected,
      amount = ride.pricing.transportFarePaisa;
    if (offerId) {
      assert(passenger && ride.pricing.pricingMode === 'NEGOTIATED', 'Passenger must select the offer', 403);
      const offer = await Offer.findOne({
        _id: offerId,
        rideId: ride._id,
        status: 'active',
        expiresAt: {
          $gt: new Date()
        }
      }).session(session);
      assert(offer, 'Offer expired or unavailable', 409);
      selected = await Driver.findById(offer.driverId).session(session);
      amount = offer.amountPaisa;
    } else {
      assert(ride.pricing.pricingMode === 'UPFRONT', 'Passenger must select an offer', 409);
      selected = driver;
    }
    assert(selected && String(selected.userId) !== String(ride.passengerId) && ['approved', 'active'].includes(selected.status) && selected.isOnline && selected.availability.status === 'available' && !selected.currentRide && !selected.currentParcel && selected.vehicleDetails.type === categoryVehicles[ride.pricing.category], 'Driver unavailable', 409);
    assert((selected.cashPayablePaisa || 0) <= ride.pricing.policy.cashPayableLimitPaisa, 'Driver has outstanding cash fees', 409);
    await verifyEligible(selected, ride, session);
    const claimed = await Driver.updateOne({
      _id: selected._id,
      currentRide: null,
      'availability.status': 'available'
    }, {
      $set: {
        currentRide: ride._id,
        'availability.status': 'busy'
      }
    }, {
      session
    });
    assert(claimed.modifiedCount === 1, 'Driver just became busy', 409);
    ride.driverId = selected._id;
    if (offerId) ride.selectedOfferId = offerId;
    ride.status = 'accepted';
    ride.pricing = {
      ...ride.pricing,
      transportFarePaisa: amount,
      acceptedAt: new Date().toISOString()
    };
    ride.receipt = finalReceipt(ride);
    ride.fare.accepted = amount / 100;
    await ride.save({
      session
    });
    await Offer.updateMany({
      rideId: ride._id
    }, {
      $set: {
        status: 'closed'
      }
    }, {
      session
    });
    return ride;
  });
}
exports.accept = async (req, res) => {
  const ride = await Ride.findById(req.params.rideId);
  if (ride?.pricing?.pricingMode === 'NEGOTIATED') return exports.offer(req, res);
  const selected = await select(req);
  await notify(req, selected, 'ride-accepted');
  res.json({
    success: true,
    ride: selected
  });
};
exports.select = async (req, res) => {
  const ride = await select(req, req.body.offerId);
  const selectedDriver = await Driver.findById(ride.driverId);
  req.app.get('io')?.to('user-' + selectedDriver.userId).emit('bid-accepted', {
    rideId: String(ride._id),
    ride
  });
  await notify(req, ride, 'ride-accepted');
  res.json({
    success: true,
    ride
  });
};
exports.offers = async (req, res) => {
  const {
    ride,
    passenger,
    assigned
  } = await owned(req);
  assert(passenger || assigned, 'Unauthorized', 403);
  const offers = await Offer.find({
    rideId: ride._id,
    status: 'active',
    expiresAt: {
      $gt: new Date()
    }
  }).lean();
  res.json({
    offers: offers.map(o => ({
      ...o,
      breakdown: receipt({
        ...ride.pricing,
        transportFarePaisa: o.amountPaisa
      }, {
        passThroughPaisa: ride.pricing.knownPassThroughPaisa || 0
      })
    }))
  });
};
exports.arrive = async (req, res) => {
  const ride = await transaction(async session => {
    const {
      ride,
      driver,
      assigned
    } = await owned(req, session);
    assert(assigned, 'Assigned driver required', 403);
    assert(ride.status === 'accepted' && !ride.pickupWaiting?.arrivedAt, 'Premature or repeated arrival', 409);
    assert(driver.locationUpdatedAt && Date.now() - driver.locationUpdatedAt <= ride.pricing.policy.locationFreshSeconds * 1000, 'Fresh GPS required', 409);
    const [a, b] = driver.location.coordinates,
      [c, d] = ride.pickup.location.coordinates;
    const rad = v => v * Math.PI / 180,
      h = Math.sin(rad(d - b) / 2) ** 2 + Math.cos(rad(b)) * Math.cos(rad(d)) * Math.sin(rad(c - a) / 2) ** 2;
    assert(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) <= ride.pricing.policy.arrivalRadiusMeters, 'Driver is too far from pickup', 409);
    ride.pickupWaiting = {
      arrivedAt: new Date(),
      authorized: true,
      warningSent: false
    };
    await ride.save({
      session
    });
    return ride;
  });
  await notify(req, ride, 'driver-arrived', {
    message: `Pickup waiting started; ${ride.pricing.policy.freeWaitingSeconds} seconds are free.`
  });
  res.json({
    success: true,
    ride
  });
};
exports.start = async (req, res) => {
  const ride = await transaction(async session => {
    const {
      ride,
      assigned
    } = await owned(req, session);
    assert(assigned, 'Assigned driver required', 403);
    if (ride.status === 'started') return ride;
    assert(ride.status === 'accepted' && ride.pickupWaiting?.authorized, 'Validated arrival required before start', 409);
    ride.pickupWaiting.endedAt = new Date();
    ride.status = 'started';
    ride.tracking.startedAt = new Date();
    await ride.save({
      session
    });
    return ride;
  });
  await notify(req, ride, 'ride-started');
  res.json({
    success: true,
    ride
  });
};
exports.complete = async (req, res) => {
  const ride = await transaction(async session => {
    const {
      ride,
      driver,
      assigned
    } = await owned(req, session);
    assert(assigned, 'Assigned driver required', 403);
    if (ride.status === 'completed') return ride;
    assert(ride.status === 'started', 'Ride not started', 409);
    assert(!req.body.fare && !req.body.amount && !req.body.finalFare, 'Driver fare edits are not allowed');
    ride.receipt = finalReceipt(ride);
    ride.fare.final = ride.receipt.passengerTotalPaisa / 100;
    ride.status = 'completed';
    ride.tracking.completedAt = new Date();
    ride.payment = {
      status: 'pending',
      amount: ride.fare.final
    };
    ride.shareToken = undefined;
    await ride.save({
      session
    });
    await Driver.updateOne({
      _id: driver._id,
      currentRide: ride._id
    }, {
      $set: {
        currentRide: null,
        'availability.status': 'available'
      },
      $inc: {
        'stats.totalRides': 1
      }
    }, {
      session
    });
    await require('../models/CallSession').updateMany({
      rideId: ride._id,
      status: {
        $in: ['ringing', 'in_progress']
      }
    }, {
      $set: {
        status: 'completed',
        endedAt: new Date(),
        endReason: 'ride_ended'
      }
    }, {
      session
    });
    return ride;
  });
  emit(req, ride, 'call:end', {
    reason: 'ride_ended'
  });
  await notify(req, ride, 'ride-completed', {
    fare: ride.fare.final
  });
  res.json({
    success: true,
    ride,
    receipt: ride.receipt
  });
};
exports.cancel = async (req, res) => {
  const ride = await transaction(async session => {
    const {
      ride,
      driver,
      assigned,
      passenger
    } = await owned(req, session);
    assert(passenger || assigned || req.user.role === 'admin', 'Unauthorized', 403);
    assert(!['completed'].includes(ride.status), 'Completed ride cannot be cancelled', 409);
    if (ride.status === 'cancelled') return ride;
    ride.status = 'cancelled';
    if (ride.pickupWaiting?.arrivedAt) ride.pickupWaiting.endedAt = new Date();
    ride.receipt = {
      currency: 'PKR',
      passengerTotalPaisa: 0,
      cancellationFeePaisa: 0
    };
    ride.fare.final = 0;
    await ride.save({
      session
    });
    if (ride.driverId) await Driver.updateOne({
      _id: ride.driverId,
      currentRide: ride._id
    }, {
      $set: {
        currentRide: null,
        'availability.status': 'available'
      }
    }, {
      session
    });
    await Offer.updateMany({
      rideId: ride._id
    }, {
      $set: {
        status: 'closed'
      }
    }, {
      session
    });
    return ride;
  });
  await notify(req, ride, 'ride-cancelled');
  res.json({
    success: true,
    ride
  });
};
exports.adjust = async (req, res) => {
  const {
    ride,
    assigned,
    passenger
  } = await owned(req);
  assert(assigned || passenger, 'Unauthorized', 403);
  assert(['accepted', 'started'].includes(ride.status), 'Ride is not adjustable', 409);
  const kind = req.body.kind;
  assert(['route', 'passThrough', 'tip'].includes(kind), 'Invalid adjustment');
  const adjustment = {
    id: crypto.randomUUID(),
    kind,
    status: 'pending',
    createdBy: String(req.user.id),
    createdAt: new Date().toISOString(),
    revision: ride.pricingRevision
  };
  if (kind === 'route') {
    assert(req.body.stops === undefined || Array.isArray(req.body.stops), 'Stops must be an array');
    const route = {
      pickup: ride.pickup,
      dropoff: point(req.body.dropoff),
      stops: (req.body.stops || []).map(point)
    };
    assert(route.stops.length <= 8, 'At most eight stops supported');
    const originalCard = await require('./models').RateCard.findById(ride.pricing.rateCardId).lean();
    for (const endpoint of [route.dropoff, ...route.stops]) assert(require('./math').inside(endpoint.location.coordinates, originalCard.zone.coordinates[0]), 'Adjusted route outside service zone', 422);
    const road = await require('../services/mapService').verifiedRoadRoute(route.pickup.location, route.dropoff.location, route.stops.map(p => p.location));
    adjustment.route = route;
    const frozenCard = {
      city: ride.pricing.city,
      category: ride.pricing.category,
      version: ride.pricing.version,
      _id: ride.pricing.rateCardId,
      rates: ride.pricing.rates,
      policy: ride.pricing.policy,
      zone: ride.pricing.zone || originalCard.zone
    };
    adjustment.pricing = require('./math').calculate(frozenCard, road.distanceMeters, road.durationSeconds, ride.pricing.multiplierBps);
    if (ride.pricing.pricingMode === 'NEGOTIATED') {
      const previousRecommended = require('./math').calculate(frozenCard, ride.pricing.distanceMeters, ride.pricing.durationSeconds, ride.pricing.multiplierBps).transportFarePaisa;
      adjustment.pricing.transportFarePaisa = Math.max(ride.pricing.rates.minimumPaisa, ride.pricing.transportFarePaisa + adjustment.pricing.transportFarePaisa - previousRecommended);
    }
    adjustment.pricing.pricingMode = ride.pricing.pricingMode;
    adjustment.newKnownPassThroughPaisa = road.knownTollPaisa || 0;
    const charges = (ride.adjustments || []).filter(a => a.status === 'approved' && a.kind === 'passThrough' && !a.autoKnown).reduce((s, a) => s + a.amountPaisa, 0);
    const tips = (ride.adjustments || []).filter(a => a.status === 'approved' && a.kind === 'tip').reduce((s, a) => s + a.amountPaisa, 0);
    adjustment.breakdown = receipt(adjustment.pricing, {
      waitingSeconds: waitingSeconds(ride),
      passThroughPaisa: charges + adjustment.newKnownPassThroughPaisa,
      tipPaisa: tips
    });
  } else {
    integer(req.body.amountPaisa, 'adjustment amount');
    assert(req.body.amountPaisa > 0 || kind === 'passThrough' && req.body.replacesAdjustmentId, 'Positive amount required unless correcting an existing charge');
    if (req.body.replacesAdjustmentId) {
      const previous = ride.adjustments.find(a => a.id === req.body.replacesAdjustmentId && a.kind === 'passThrough' && a.status === 'approved');
      assert(kind === 'passThrough' && previous, 'Approved charge to replace not found', 409);
      adjustment.replacesAdjustmentId = previous.id;
      adjustment.autoKnown = previous.autoKnown || false;
    }
    adjustment.amountPaisa = req.body.amountPaisa;
    adjustment.reason = req.body.reason;
    assert(typeof adjustment.reason === 'string' && adjustment.reason.trim().length >= 3, 'Reason required');
    if (kind === 'passThrough') {
      assert(['toll', 'parking', 'airport'].includes(req.body.chargeType), 'Invalid pass-through charge');
      assert(typeof req.body.evidence === 'string' && req.body.evidence.length >= 5, 'Documented evidence required');
      adjustment.evidence = req.body.evidence;
      adjustment.chargeType = req.body.chargeType;
    }
  }
  if (kind !== 'route') {
    const current = finalReceipt(ride);
    adjustment.breakdown = receipt(ride.pricing, {
      waitingSeconds: waitingSeconds(ride),
      passThroughPaisa: current.passThroughPaisa + (kind === 'passThrough' ? adjustment.amountPaisa : 0) - (adjustment.replacesAdjustmentId ? ride.adjustments.find(a => a.id === adjustment.replacesAdjustmentId).amountPaisa : 0),
      tipPaisa: current.tipPaisa + (kind === 'tip' ? adjustment.amountPaisa : 0)
    });
  }
  const updated = await Ride.findOneAndUpdate({
    _id: ride._id,
    pricingRevision: ride.pricingRevision,
    status: {
      $in: ['accepted', 'started']
    }
  }, {
    $push: {
      adjustments: adjustment
    },
    $inc: {
      pricingRevision: 1
    }
  }, {
    new: true
  });
  assert(updated, 'Ride changed, refresh', 409);
  await notify(req, updated, 'pricing-adjustment', {
    message: 'Please review and approve the proposed fare adjustment.'
  });
  res.status(201).json({
    adjustment
  });
};
exports.approveAdjustment = async (req, res) => {
  const ride = await transaction(async session => {
    const {
      ride,
      passenger
    } = await owned(req, session);
    assert(passenger, 'Passenger approval required', 403);
    assert(['accepted', 'started'].includes(ride.status), 'Ride no longer adjustable', 409);
    const adjustment = ride.adjustments.find(a => a.id === req.params.adjustmentId);
    assert(adjustment && adjustment.status === 'pending', 'Adjustment unavailable', 409);
    if (req.body.approved === true && adjustment.replacesAdjustmentId) {
      const previous = ride.adjustments.find(a => a.id === adjustment.replacesAdjustmentId && a.status === 'approved');
      assert(previous, 'Charge changed; refresh proposal', 409);
      previous.status = 'superseded';
    }
    adjustment.status = req.body.approved === true ? 'approved' : 'rejected';
    adjustment.approvedAt = new Date().toISOString();
    adjustment.approvedBy = String(req.user.id);
    if (adjustment.status === 'approved' && adjustment.kind === 'route') {
      ride.pricingHistory.push({
        pricing: ride.pricing,
        route: {
          pickup: ride.pickup,
          dropoff: ride.dropoff,
          stops: ride.waypoints
        },
        at: new Date(),
        approval: adjustment.id
      });
      for (const a of ride.adjustments) if (a.autoKnown && a.status === 'approved') a.status = 'superseded';
      if (adjustment.newKnownPassThroughPaisa) ride.adjustments.push({
        id: crypto.randomUUID(),
        kind: 'passThrough',
        chargeType: 'toll',
        status: 'approved',
        autoKnown: true,
        amountPaisa: adjustment.newKnownPassThroughPaisa,
        evidence: 'Google Routes road toll estimate in approved route revision',
        approvedBy: String(req.user.id),
        approvedAt: new Date().toISOString()
      });
      ride.pricing = adjustment.pricing;
      ride.dropoff = adjustment.route.dropoff;
      ride.waypoints = adjustment.route.stops;
      for (const a of ride.adjustments) if (a.kind === 'route' && a.id !== adjustment.id && a.status === 'pending') a.status = 'superseded';
    }
    ride.markModified('adjustments');
    ride.receipt = finalReceipt(ride);
    ride.pricingRevision++;
    await ride.save({
      session
    });
    await PricingAudit.create([{
      actor: req.user.id,
      action: 'PASSENGER_ADJUSTMENT',
      entity: String(ride._id),
      data: adjustment
    }], {
      session
    });
    return ride;
  });
  emit(req, ride, 'pricing-updated');
  res.json({
    ride
  });
};
exports.receipt = async (req, res) => {
  const {
    ride,
    passenger,
    assigned
  } = await owned(req);
  assert(passenger || assigned || req.user.role === 'admin', 'Unauthorized', 403);
  res.json({
    dropoff: ride.dropoff,
    stops: ride.waypoints,
    status: ride.status,
    settlement: await require('./models').Settlement.findOne({
      rideId: ride._id
    }).lean(),
    cashRefunds: await require('./models').CashRefund.find({
      rideId: ride._id,
      status: {
        $in: ['pending', 'disputed']
      }
    }).lean(),
    rideId: ride._id,
    receipt: ride.receipt,
    pricing: ride.pricing,
    payment: ride.payment,
    waiting: ride.pickupWaiting,
    adjustments: ride.adjustments
  });
};
exports.waitingSeconds = waitingSeconds;
