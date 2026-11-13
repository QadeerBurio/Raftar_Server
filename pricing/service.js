const mongoose = require('mongoose');
const {
  RateCard,
  Quote,
  SurgeState
} = require('./models');
const Ride = require('../models/Ride');
const Driver = require('../models/Driver');
const math = require('./math');
async function assertReady() {
  math.assert(await require('./models').Scope.exists({
    _id: 'pricing-v1-ready'
  }), 'Pricing migration is required before quoting or financial settlement', 503);
}
async function cardFor(city, category, now = new Date()) {
  await assertReady();
  math.assert(typeof city === 'string' && city.trim() && math.categoryVehicles[category], 'Explicit city and supported category required');
  const card = await RateCard.findOne({
    city: city.trim().toLowerCase(),
    category,
    status: 'published',
    effectiveFrom: {
      $lte: now
    },
    effectiveTo: {
      $gt: now
    }
  }).lean();
  math.assert(card, 'No published rate card for this city/category', 422);
  return card;
}
async function eligibleSupply(match) {
  const count = await Driver.aggregate([{
    $match: match
  }, {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      as: 'account'
    }
  }, {
    $match: {
      'account.isActive': true
    }
  }, {
    $count: 'total'
  }]);
  return count[0]?.total || 0;
}
async function demandSurge(card, now) {
  const key = String(card._id);
  const active = await Ride.distinct('driverId', {
    status: {
      $in: ['accepted', 'started']
    },
    driverId: {
      $ne: null
    }
  });
  const sampledAt = new Date();
  const [demand, supply, previous] = await Promise.all([card.policy.surge.mode === 'LIVE_DEMAND' ? Ride.countDocuments({
    status: 'searching',
    'pricing.city': card.city,
    'pricing.category': card.category,
    createdAt: {
      $gte: new Date(now - 300000)
    },
    'pickup.location': {
      $geoWithin: {
        $geometry: card.zone
      }
    }
  }) : Promise.resolve(0), eligibleSupply({
    _id: {
      $nin: active
    },
    status: {
      $in: ['approved', 'active']
    },
    isOnline: true,
    cashPayablePaisa: {
      $lte: card.policy.cashPayableLimitPaisa
    },
    currentRide: null,
    currentParcel: null,
    'vehicleDetails.type': math.categoryVehicles[card.category],
    'availability.status': 'available',
    'availability.lastUpdated': {
      $gte: new Date(now - card.policy.surge.freshnessSeconds * 1000)
    },
    locationUpdatedAt: {
      $gte: new Date(now - card.policy.surge.freshnessSeconds * 1000)
    },
    location: {
      $geoWithin: {
        $geometry: card.zone
      }
    }
  }), SurgeState.findById(key).lean()]);
  const metrics = {
    now: new Date(),
    demand,
    supply,
    sampledAt,
    previous: previous?.multiplierBps || 10000,
    changedAt: previous?.changedAt || new Date(0)
  };
  const result = math.surge(card.policy, metrics);
  if (supply === 0) {
    result.available = false;
    result.reason = 'NO_ELIGIBLE_DRIVERS';
  }
  if (card.policy.surge.mode === 'LIVE_DEMAND') {
    const previous = await SurgeState.findById(key).lean();
    await SurgeState.findByIdAndUpdate(key, {
      $set: {
        multiplierBps: result.multiplierBps,
        sampledAt: now,
        changedAt: previous?.multiplierBps === result.multiplierBps ? previous.changedAt : now
      }
    }, {
      upsert: true
    });
  }
  if (result.reason === 'STALE_DEMAND') console.warn('[pricing] stale demand: reverting to 1.00');
  return result;
}
async function makeQuote(owner, input) {
  math.assert(process.env.PRICING_NEW_QUOTES_ENABLED !== 'false', 'New quotes are temporarily disabled', 503);
  await assertReady();
  math.assert(input && typeof input === 'object' && !Array.isArray(input), 'Quote request body required');
  math.assert(input.stops === undefined || Array.isArray(input.stops), 'Stops must be an array');
  const now = new Date();
  const card = await cardFor(input.city, input.category, now);
  const route = {
    pickup: math.point(input.pickup),
    dropoff: math.point(input.dropoff),
    stops: (input.stops || []).map(math.point)
  };
  math.assert(route.stops.length <= 8, 'At most eight stops supported');
  for (const p of [route.pickup, ...route.stops, route.dropoff]) math.assert(math.inside(p.location.coordinates, card.zone.coordinates[0]), 'Route endpoint outside configured service zone', 422);
  const pricingMode = input.pricingMode || 'UPFRONT';
  math.assert(['UPFRONT', 'NEGOTIATED'].includes(pricingMode) && (pricingMode !== 'NEGOTIATED' || card.policy.negotiatedEnabled), 'Negotiated pricing is disabled');
  const road = await require('../services/mapService').verifiedRoadRoute(route.pickup.location, route.dropoff.location, route.stops.map(p => p.location));
  const busy = await demandSurge(card, new Date());
  math.assert(busy.available, 'No eligible drivers available. Please retry later.', 409);
  const snapshot = {
    ...math.calculate(card, road.distanceMeters, road.durationSeconds, busy.multiplierBps),
    pricingMode,
    surgeReason: busy.reason,
    availability: 'available',
    routePolyline: road.polyline,
    quotedAt: now.toISOString()
  };
  snapshot.knownPassThroughPaisa = road.knownTollPaisa || 0;
  snapshot.tollDisclosure = snapshot.knownPassThroughPaisa ? 'Known road toll estimate: PKR ' + (snapshot.knownPassThroughPaisa / 100).toFixed(2) + ' included as a pass-through charge; no surge or service fee applies.' : road.hasTolls ? 'This route includes tolls. The provider has no verified toll amount; any toll charge requires documented passenger approval.' : 'No verified toll price supplied. Unexpected tolls, parking or airport charges require documented passenger approval.';
  snapshot.breakdown = math.receipt(snapshot, {
    passThroughPaisa: snapshot.knownPassThroughPaisa
  });
  snapshot.offerBounds = math.offerBounds(snapshot);
  const quote = await Quote.create({
    owner,
    route,
    pricingMode,
    snapshot,
    expiresAt: new Date(Date.now() + card.policy.quoteLifetimeSeconds * 1000)
  });
  return quote;
}
async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
module.exports = {
  assertReady,
  cardFor,
  demandSurge,
  makeQuote,
  transaction
};
