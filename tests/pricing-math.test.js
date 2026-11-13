const test = require('node:test');
const assert = require('node:assert/strict');
const math = require('../pricing/math');
const {
  defaults,
  validateCard
} = require('../pricing/config');
const pilot = require('../pricing/pilot');
const economy = () => structuredClone(pilot.find(c => c.category === 'economy'));
test('Economy road route: 10km/25min normal PKR 504.70', () => {
  const p = math.calculate(economy(), 10000, 1500);
  assert.equal(p.transportFarePaisa, 49000);
  assert.equal(p.breakdown.serviceFeePaisa, 1470);
  assert.equal(p.breakdown.passengerTotalPaisa, 50470);
  assert.equal(p.breakdown.driverEntitlementPaisa, 49000);
  assert.equal(p.policy.driverCommissionBps, 0);
});
test('Economy at 1.25: half-up service fee PKR 18.38', () => {
  const p = math.calculate(economy(), 10000, 1500, 12500);
  assert.equal(p.transportFarePaisa, 61250);
  assert.equal(p.breakdown.serviceFeePaisa, 1838);
  assert.equal(p.breakdown.passengerTotalPaisa, 63088);
});
test('Minimum fare and raw sub-paisa arithmetic', () => {
  assert.equal(math.calculate(economy(), 0, 0).transportFarePaisa, 18000);
  assert.equal(math.halfUp(5, 2), 3);
  assert.equal(math.money('18.38'), 1838);
  assert.throws(() => math.money('1.001'));
  assert.throws(() => math.money(Infinity));
  assert.throws(() => math.money('-1'));
});
test('Negative, non-finite and fractional server measurements rejected', () => {
  for (const n of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => math.calculate(economy(), n, 1500));
    assert.throws(() => math.calculate(economy(), 10000, n));
  }
  assert.throws(() => math.calculate(economy(), 1, 1, 15001));
});
test('Free waiting, prorated seconds, no extra traffic minutes', () => {
  const p = math.calculate(economy(), 10000, 1500);
  assert.equal(math.receipt(p, {
    waitingSeconds: 180
  }).waitingPaisa, 0);
  assert.equal(math.receipt(p, {
    waitingSeconds: 210
  }).waitingPaisa, 250);
  assert.equal(math.receipt(p, {
    waitingSeconds: 181
  }).waitingPaisa, 8);
  assert.equal(math.receipt(p).transportFarePaisa, 49000);
});
test('Pass-through charges and tips excluded from surge, service fee and commission', () => {
  const p = math.calculate(economy(), 10000, 1500, 12500);
  const r = math.receipt(p, {
    passThroughPaisa: 10000,
    tipPaisa: 2000
  });
  assert.equal(r.serviceFeePaisa, 1838);
  assert.equal(r.passengerTotalPaisa, 75088);
  assert.equal(r.driverEntitlementPaisa, 73250);
  assert.equal(r.platformRevenuePaisa, 1838);
});
test('Explicit commission is separate from passenger fee', () => {
  const c = economy();
  c.policy.driverCommissionBps = 1000;
  const p = math.calculate(c, 10000, 1500);
  assert.equal(p.breakdown.commissionPaisa, 4900);
  assert.equal(p.breakdown.driverEntitlementPaisa, 44100);
  assert.equal(p.breakdown.platformRevenuePaisa, 6370);
  assert.equal(p.breakdown.passengerTotalPaisa, 50470);
});
test('Snapshot independent of rate card mutation', () => {
  const c = economy(),
    p = math.calculate(c, 10000, 1500);
  c.rates.basePaisa = 99999;
  c.policy.serviceFeeBps = 999;
  assert.equal(p.rates.basePaisa, 9000);
  assert.equal(p.policy.serviceFeeBps, 300);
});
test('Weekday Asia/Karachi schedules use one multiplier and exact boundaries', () => {
  const p = structuredClone(defaults);
  for (const [date, expected] of [['2026-11-13T03:00:00Z', 11500], ['2026-11-13T05:00:00Z', 10000], ['2026-11-14T03:00:00Z', 10000]]) assert.equal(math.surge(p, {
    now: new Date(date)
  }).multiplierBps, expected);
  p.surge.mode = 'OFF';
  assert.equal(math.surge(p, {
    now: new Date('2026-11-13T03:00:00Z')
  }).multiplierBps, 10000);
});
test('Live thresholds, sample minimum, zero supply and stale data', () => {
  const p = structuredClone(defaults);
  p.surge.mode = 'LIVE_DEMAND';
  for (const [demand, supply, expected] of [[10, 10, 10000], [12, 10, 11000], [18, 10, 12500], [25, 10, 15000], [1000, 1, 15000], [9, 1, 10000]]) assert.equal(math.surge(p, {
    demand,
    supply
  }).multiplierBps, expected);
  assert.equal(math.surge(p, {
    demand: 10,
    supply: 0
  }).available, false);
  const r = math.surge(p, {
    demand: 100,
    supply: 1,
    sampledAt: new Date(0)
  });
  assert.equal(r.multiplierBps, 10000);
  assert.equal(r.reason, 'STALE_DEMAND');
});
test('Hysteresis holds changes then allows stable transitions', () => {
  const p = structuredClone(defaults);
  p.surge.mode = 'LIVE_DEMAND';
  const now = new Date();
  assert.equal(math.surge(p, {
    now,
    demand: 12,
    supply: 10,
    previous: 12500,
    changedAt: now
  }).multiplierBps, 12500);
  assert.equal(math.surge(p, {
    now,
    demand: 17,
    supply: 10,
    previous: 12500,
    changedAt: new Date(0)
  }).multiplierBps, 12500);
  assert.equal(math.surge(p, {
    now,
    demand: 12,
    supply: 10,
    previous: 12500,
    changedAt: new Date(0)
  }).multiplierBps, 11000);
});
test('Negotiated transport offer bounds; no repeated surge', () => {
  const p = math.calculate(economy(), 10000, 1500, 12500);
  assert.deepEqual(math.offerBounds(p), {
    minimumPaisa: 52063,
    maximumPaisa: 91875
  });
  assert.throws(() => math.validateOffer(p, 52062));
  assert.throws(() => math.validateOffer(p, 91876));
  math.validateOffer(p, 60000);
  const r = math.receipt({
    ...p,
    transportFarePaisa: 60000
  });
  assert.equal(r.passengerTotalPaisa, 61800);
});
test('Admin card validation rejects overlapping schedules, taxes and unbounded overrides', () => {
  const c = economy();
  validateCard(c);
  c.policy.surge.schedules.push(c.policy.surge.schedules[0]);
  assert.throws(() => validateCard(c));
  const x = economy();
  x.policy.statutoryTaxesEnabled = true;
  assert.throws(() => validateCard(x));
  const y = economy();
  y.policy.surge.override = {
    multiplierBps: 20000,
    reason: 'bad weather',
    expiresAt: new Date(Date.now() + 60000)
  };
  assert.throws(() => validateCard(y));
});
test('Service polygon rejects other cities; coordinates strict', () => {
  assert.equal(math.inside([67, 24.9], economy().zone.coordinates[0]), true);
  assert.equal(math.inside([74.3, 31.5], economy().zone.coordinates[0]), false);
  assert.throws(() => math.point({
    lat: NaN,
    lng: 67
  }));
  assert.throws(() => math.point({
    lat: 24,
    lng: 181
  }));
});
test('Partial refunds accumulate to original allocations exactly', () => {
  const original = math.calculate(economy(), 10000, 1500, 12500).breakdown;
  const {
    cumulativeRefund
  } = require('../pricing/settlement');
  const a = cumulativeRefund(original, 1),
    b = cumulativeRefund(original, original.passengerTotalPaisa);
  assert.equal(a.driverEntitlementPaisa + a.platformRevenuePaisa, 1);
  assert.equal(b.serviceFeePaisa, original.serviceFeePaisa);
  assert.equal(b.driverEntitlementPaisa, original.driverEntitlementPaisa);
  assert.throws(() => cumulativeRefund(original, original.passengerTotalPaisa + 1));
});
test('Negotiation bounds continue to use recommendation after passenger offers less', () => {
  const p = math.calculate(economy(), 10000, 1500, 12500);
  const offered = {
    ...p,
    transportFarePaisa: 53000
  };
  assert.deepEqual(math.offerBounds(offered), {
    minimumPaisa: 52063,
    maximumPaisa: 91875
  });
  math.validateOffer(offered, 90000);
});
test('Legacy mirror rounding crosses one explicit decimal-safe half-up boundary', () => {
  assert.equal(math.roundDecimalPaisa(0.1 + 0.2), 30);
  assert.equal(math.roundDecimalPaisa('1.005'), 101);
  assert.equal(math.roundDecimalPaisa('1e-2'), 1);
  assert.throws(() => math.roundDecimalPaisa(-1));
});
