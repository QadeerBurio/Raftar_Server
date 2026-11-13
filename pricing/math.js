const assert = (condition, message, statusCode = 400) => {
  if (!condition) {
    const e = new Error(message);
    e.statusCode = statusCode;
    throw e;
  }
};
const integer = (n, label = 'value', max = 1000000000) => {
  assert(Number.isSafeInteger(n) && n >= 0 && n <= max, `${label} must be a non-negative integer`);
  return n;
};
const halfUp = (n, d) => {
  n = BigInt(n);
  d = BigInt(d);
  assert(n >= 0n && d > 0n, 'Invalid money calculation');
  const result = Number((n * 2n + d) / (2n * d));
  assert(Number.isSafeInteger(result), 'Money overflow');
  return result;
};
const bps = (amount, rate) => halfUp(BigInt(integer(amount)) * BigInt(integer(rate, 'basis points', 10000)), 10000);
const money = value => {
  assert(typeof value === 'string' || typeof value === 'number', 'Invalid monetary value');
  const text = String(value);
  assert(/^\d+(\.\d{1,2})?$/.test(text), 'Money must have at most two decimal places');
  const [whole, fraction = ''] = text.split('.');
  return integer(Number(whole) * 100 + Number(fraction.padEnd(2, '0')), 'money');
};
// Legacy PKR mirrors cross a single half-up boundary when saved. New APIs accept integer paisa.
const roundDecimalPaisa = value => {
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  assert(match && Number.isFinite(Number(value)), 'Invalid legacy balance');
  const fraction = match[2] || '',
    scale = fraction.length - Number(match[3] || 0);
  assert(Math.abs(scale) <= 100, 'Invalid balance precision');
  const coefficient = BigInt(match[1] + fraction) * 100n;
  return integer(scale >= 0 ? halfUp(coefficient, 10n ** BigInt(scale)) : halfUp(coefficient * 10n ** BigInt(-scale), 1), 'balance');
};
const categoryVehicles = {
  bike: 'bike',
  rickshaw: 'rickshaw',
  economy: 'car',
  comfort: 'ac_car'
};
function point(input) {
  const coords = input?.location?.coordinates || input?.coordinates || input && [input.lng ?? input.longitude, input.lat ?? input.latitude];
  assert(Array.isArray(coords) && coords.length === 2 && coords.every(Number.isFinite) && Math.abs(coords[0]) <= 180 && Math.abs(coords[1]) <= 90, 'Valid longitude/latitude required');
  return {
    address: input.address || '',
    location: {
      type: 'Point',
      coordinates: coords
    }
  };
}
function inside(coords, polygon) {
  let yes = false;
  const [x, y] = coords;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i],
      [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}
function receipt(snapshot, {
  waitingSeconds = 0,
  passThroughPaisa = 0,
  tipPaisa = 0
} = {}) {
  integer(waitingSeconds, 'waiting seconds');
  integer(passThroughPaisa);
  integer(tipPaisa);
  const paidSeconds = Math.max(0, waitingSeconds - snapshot.policy.freeWaitingSeconds);
  const waitingPaisa = halfUp(BigInt(paidSeconds) * BigInt(snapshot.rates.waitingPerMinutePaisa), 60);
  const eligibleFarePaisa = integer(snapshot.transportFarePaisa + waitingPaisa);
  const serviceFeePaisa = bps(eligibleFarePaisa, snapshot.policy.serviceFeeBps);
  const commissionPaisa = bps(eligibleFarePaisa, snapshot.policy.driverCommissionBps);
  return {
    currency: 'PKR',
    transportFarePaisa: snapshot.transportFarePaisa,
    waitingPaisa,
    eligibleFarePaisa,
    serviceFeePaisa,
    serviceFeeLabel: `Raftar service fee — ${snapshot.policy.serviceFeeBps / 100}%`,
    commissionPaisa,
    passThroughPaisa,
    tipPaisa,
    driverEntitlementPaisa: eligibleFarePaisa - commissionPaisa + passThroughPaisa + tipPaisa,
    platformRevenuePaisa: serviceFeePaisa + commissionPaisa,
    passengerTotalPaisa: integer(eligibleFarePaisa + serviceFeePaisa + passThroughPaisa + tipPaisa),
    statutoryTaxPaisa: 0
  };
}
function calculate(card, distanceMeters, durationSeconds, multiplierBps = 10000) {
  integer(distanceMeters, 'route distance', 10000000);
  integer(durationSeconds, 'route duration', 604800);
  integer(multiplierBps, 'multiplier', 15000);
  assert(multiplierBps >= 10000, 'Surge cannot discount the fare');
  const r = card.rates;
  // Common denominator 3000: distance in metres, time in seconds. Round once after minimum and surge.
  const raw = BigInt(r.basePaisa) * 3000n + BigInt(distanceMeters) * BigInt(r.perKmPaisa) * 3n + BigInt(durationSeconds) * BigInt(r.perMinutePaisa) * 50n;
  const floor = BigInt(r.minimumPaisa) * 3000n;
  const transportFarePaisa = halfUp((raw > floor ? raw : floor) * BigInt(multiplierBps), 30000000);
  const snapshot = {
    schemaVersion: 1,
    currency: 'PKR',
    city: card.city,
    category: card.category,
    version: card.version,
    rateCardId: String(card._id || ''),
    zone: card.zone ? structuredClone(card.zone) : undefined,
    rates: structuredClone(r),
    policy: structuredClone(card.policy),
    distanceMeters,
    durationSeconds,
    multiplierBps,
    transportFarePaisa,
    recommendedTransportFarePaisa: transportFarePaisa
  };
  return {
    ...snapshot,
    breakdown: receipt(snapshot)
  };
}
function offerBounds(snapshot) {
  const recommendation = snapshot.recommendedTransportFarePaisa ?? snapshot.transportFarePaisa;
  return {
    minimumPaisa: Math.max(snapshot.rates.minimumPaisa, bps(recommendation, snapshot.policy.offerMinimumBps)),
    maximumPaisa: halfUp(BigInt(recommendation) * BigInt(snapshot.policy.offerMaximumBps), 10000)
  };
}
function validateOffer(snapshot, amount) {
  integer(amount, 'offer');
  const bounds = offerBounds(snapshot);
  assert(amount >= bounds.minimumPaisa && amount <= bounds.maximumPaisa, `Offer must be between ${bounds.minimumPaisa} and ${bounds.maximumPaisa} paisa`);
  return amount;
}
function surge(policy, {
  now = new Date(),
  demand = 0,
  supply = 0,
  sampledAt = now,
  previous = 10000,
  changedAt = new Date(0)
} = {}) {
  const p = policy.surge;
  if (p.mode === 'LIVE_DEMAND' && supply === 0) return {
    multiplierBps: 10000,
    available: false,
    reason: 'NO_ELIGIBLE_DRIVERS'
  };
  let target = 10000,
    reason = p.mode;
  if (p.mode === 'SCHEDULED') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now).map(x => [x.type, x.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    target = p.schedules.find(s => s.days.includes(parts.weekday) && minute >= s.startMinute && minute < s.endMinute)?.multiplierBps || 10000;
  }
  if (p.mode === 'LIVE_DEMAND') {
    if (now - new Date(sampledAt) > p.staleSeconds * 1000) reason = 'STALE_DEMAND';else if (demand < p.minimumRequests) reason = 'INSUFFICIENT_SAMPLE';else {
      const ratio = demand / supply;
      target = p.thresholds.reduce((v, t) => ratio >= t.ratio ? t.multiplierBps : v, 10000);
      if (target !== previous && now - new Date(changedAt) < p.holdSeconds * 1000) target = previous;else if (target < previous && p.thresholds.some(t => t.multiplierBps === previous && ratio >= t.ratio - p.hysteresis)) target = previous;
    }
  }
  if (p.override && new Date(p.override.expiresAt) > now) {
    target = p.override.multiplierBps;
    reason = 'MANUAL_OVERRIDE';
  }
  return {
    multiplierBps: Math.min(target, p.capBps, 15000),
    available: true,
    reason
  };
}
module.exports = {
  roundDecimalPaisa,
  assert,
  integer,
  halfUp,
  bps,
  money,
  point,
  inside,
  calculate,
  receipt,
  offerBounds,
  validateOffer,
  surge,
  categoryVehicles
};
