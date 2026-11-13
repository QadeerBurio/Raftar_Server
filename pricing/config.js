const {
  assert,
  integer,
  categoryVehicles
} = require('./math');
const defaults = {
  serviceFeeBps: 300,
  driverCommissionBps: 0,
  statutoryTaxesEnabled: false,
  quoteLifetimeSeconds: 120,
  negotiatedEnabled: false,
  offerMinimumBps: 8500,
  offerMaximumBps: 15000,
  offerLifetimeSeconds: 120,
  freeWaitingSeconds: 180,
  arrivalRadiusMeters: 150,
  locationFreshSeconds: 30,
  waitingNoticeSeconds: 30,
  cashPayableLimitPaisa: 500000,
  surge: {
    mode: 'SCHEDULED',
    capBps: 15000,
    freshnessSeconds: 60,
    staleSeconds: 30,
    minimumRequests: 10,
    holdSeconds: 120,
    hysteresis: 0.1,
    schedules: [{
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      startMinute: 480,
      endMinute: 600,
      multiplierBps: 11500
    }, {
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      startMinute: 1020,
      endMinute: 1200,
      multiplierBps: 11500
    }],
    thresholds: [{
      ratio: 1.2,
      multiplierBps: 11000
    }, {
      ratio: 1.8,
      multiplierBps: 12500
    }, {
      ratio: 2.5,
      multiplierBps: 15000
    }]
  }
};
function validateCard(card) {
  assert(typeof card.city === 'string' && card.city.trim().length > 0 && card.city.length < 100, 'City required');
  assert(categoryVehicles[card.category], 'Unsupported category');
  assert(typeof card.version === 'string' && card.version.length > 0 && card.version.length <= 80, 'Version required');
  const from = new Date(card.effectiveFrom),
    to = new Date(card.effectiveTo);
  assert(Number.isFinite(+from) && Number.isFinite(+to) && to > from, 'Valid effective interval required');
  for (const k of ['basePaisa', 'perKmPaisa', 'perMinutePaisa', 'minimumPaisa', 'waitingPerMinutePaisa']) integer(card.rates?.[k], k);
  const p = card.policy;
  assert(p && typeof p.negotiatedEnabled === 'boolean', 'Negotiation feature flag required');
  integer(p.serviceFeeBps, 'service fee', 10000);
  integer(p.driverCommissionBps, 'commission', 10000);
  assert(p.statutoryTaxesEnabled === false, 'Statutory taxes are disabled until verified jurisdiction configuration is implemented');
  for (const k of ['quoteLifetimeSeconds', 'offerLifetimeSeconds', 'freeWaitingSeconds', 'arrivalRadiusMeters', 'locationFreshSeconds', 'waitingNoticeSeconds', 'cashPayableLimitPaisa']) integer(p[k], k);
  assert(p.waitingNoticeSeconds <= p.freeWaitingSeconds, 'Waiting warning must fit within the free period');
  assert(p.quoteLifetimeSeconds >= 15 && p.quoteLifetimeSeconds <= 600 && p.offerLifetimeSeconds > 0 && p.locationFreshSeconds > 0 && p.arrivalRadiusMeters > 0, 'Invalid expiry or arrival policy');
  integer(p.offerMinimumBps, 'offer minimum', 10000);
  integer(p.offerMaximumBps, 'offer maximum', 30000);
  assert(p.offerMaximumBps >= 10000, 'Offer maximum must be at least 100%');
  const s = p.surge;
  assert(s && ['OFF', 'SCHEDULED', 'LIVE_DEMAND'].includes(s.mode), 'One surge mode required');
  integer(s.capBps, 'surge cap', 15000);
  assert(s.capBps >= 10000, 'Cap below 1.0');
  for (const k of ['freshnessSeconds', 'staleSeconds', 'minimumRequests', 'holdSeconds']) {
    integer(s[k], k);
    assert(s[k] > 0, `${k} must be positive`);
  }
  assert(Number.isFinite(s.hysteresis) && s.hysteresis >= 0 && s.hysteresis < 1, 'Invalid hysteresis');
  assert(Array.isArray(s.thresholds) && s.thresholds.length > 0 && s.thresholds.length <= 20, 'Thresholds required');
  let ratio = 0,
    mult = 10000;
  for (const t of s.thresholds) {
    assert(Number.isFinite(t.ratio) && t.ratio > ratio, 'Thresholds must ascend');
    integer(t.multiplierBps, 'threshold multiplier', s.capBps);
    assert(t.multiplierBps >= mult, 'Multipliers must ascend');
    ratio = t.ratio;
    mult = t.multiplierBps;
  }
  assert(Array.isArray(s.schedules) && s.schedules.length <= 30, 'Invalid schedules');
  const occupied = new Set();
  for (const w of s.schedules) {
    integer(w.startMinute, 'start minute', 1439);
    integer(w.endMinute, 'end minute', 1440);
    assert(w.endMinute > w.startMinute && Array.isArray(w.days) && w.days.length > 0, 'Invalid schedule');
    integer(w.multiplierBps, 'schedule multiplier', s.capBps);
    assert(w.multiplierBps >= 10000, 'Invalid schedule multiplier');
    for (const d of w.days) {
      assert(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(d), 'Invalid weekday');
      for (let i = w.startMinute; i < w.endMinute; i++) {
        const key = d + ':' + i;
        assert(!occupied.has(key), 'Overlapping surge schedules');
        occupied.add(key);
      }
    }
  }
  if (s.override) {
    integer(s.override.multiplierBps, 'override multiplier', s.capBps);
    assert(s.override.multiplierBps >= 10000 && typeof s.override.reason === 'string' && s.override.reason.trim().length >= 5, 'Override reason required');
    const expiry = new Date(s.override.expiresAt);
    assert(expiry > new Date() && expiry - Date.now() <= 24 * 3600000, 'Override expiry must be within 24 hours');
  }
  assert(card.zone?.type === 'Polygon' && Array.isArray(card.zone.coordinates) && card.zone.coordinates.length === 1, 'Explicit single service polygon required');
  const ring = card.zone.coordinates[0];
  assert(ring.length >= 4 && ring.length <= 200 && JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1)), 'Polygon must be closed');
  for (const xy of ring) assert(Array.isArray(xy) && xy.length === 2 && xy.every(Number.isFinite) && Math.abs(xy[0]) <= 180 && Math.abs(xy[1]) <= 90, 'Invalid polygon');
  return {
    city: card.city.trim().toLowerCase(),
    category: card.category,
    version: card.version,
    effectiveFrom: from,
    effectiveTo: to,
    rates: card.rates,
    policy: p,
    zone: card.zone
  };
}
module.exports = {
  defaults,
  validateCard
};
