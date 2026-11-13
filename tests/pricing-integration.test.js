const test = require('node:test');
const assert = require('node:assert/strict');
const cases = ['quote ownership, expiry, consumption, route/category binding and fare tampering', 'concurrent quote consumption and retry idempotency', 'simultaneous driver selection and expired offers', 'arrival GPS ownership, free waiting, start/complete and unauthorized changes', 'accepted pricing unaffected by new rate cards and traffic delay', 'concurrent wallet settlement and driver/platform allocations', 'wallet settlement rollback on ledger failure', 'cash acknowledgements, fee receivable and reconciliation', 'partial refunds and cash-return acknowledgement reversal', 'draft publication overlap and immutable audits'];
if (!process.env.PRICING_TEST_URI) {
  for (const name of cases) test(name, {
    skip: 'Set PRICING_TEST_URI to an explicitly disposable MongoDB replica set'
  }, () => {});
} else test('Disposable replica-set integration', async t => {
  t.mock.method(console, 'error', () => {});
  const mongoose = require('mongoose');
  const crypto = require('crypto');
  const dbName = 'raftar_pricing_test_' + crypto.randomBytes(6).toString('hex');
  await mongoose.connect(process.env.PRICING_TEST_URI, {
    dbName,
    autoIndex: false,
    serverSelectionTimeoutMS: 8000
  });
  t.after(async () => {
    if (mongoose.connection.readyState) {
      assert.match(mongoose.connection.name, /^raftar_pricing_test_[a-f0-9]+$/);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });
  const models = require('../pricing/models'),
    Ride = require('../models/Ride'),
    User = require('../models/User'),
    Driver = require('../models/Driver'),
    Payment = require('../models/Payment');
  const hello = await mongoose.connection.db.admin().command({
    hello: 1
  });
  assert.ok(hello.setName || hello.msg === 'isdbgrid', 'Replica set required');
  for (const m of [...Object.values(models), Ride, User, Driver, Payment]) await m.createIndexes();
  const migrationUri = process.env.PRICING_TEST_URI.replace(/(mongodb(?:\+srv)?:\/\/[^/]+)(\/[^?]*)?/, '$1/' + dbName);
  const legacyId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id: legacyId,
    name: 'Legacy wallet fixture',
    phoneNumber: '+923001110099',
    wallet: {
      balance: 12.34
    },
    isActive: true
  });
  await Ride.collection.dropIndex('bookingKey_1');
  await Ride.collection.insertMany([{
    bookingKey: 'duplicate-preflight'
  }, {
    bookingKey: 'duplicate-preflight'
  }]);
  const blocked = require('child_process').spawnSync(process.execPath, ['scripts/pricing-migrate.js'], {
    cwd: require('path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PRICING_MIGRATION_URI: migrationUri
    },
    encoding: 'utf8'
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stdout, /duplicate bookingKey/);
  await Ride.collection.deleteMany({
    bookingKey: 'duplicate-preflight'
  });
  await Ride.createIndexes();
  const migrated = require('child_process').spawnSync(process.execPath, ['scripts/pricing-migrate.js', '--apply', '--seed'], {
    cwd: require('path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PRICING_MIGRATION_URI: migrationUri
    },
    encoding: 'utf8'
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  assert.equal(await models.RateCard.countDocuments({
    status: 'draft'
  }), 4);
  assert.ok(await models.Scope.exists({
    _id: 'pricing-v1-ready'
  }));
  assert.equal((await User.collection.findOne({
    _id: legacyId
  })).wallet.balancePaisa, 1234);
  const notificationPath = require.resolve('../services/notificationService');
  require.cache[notificationPath] = {
    id: notificationPath,
    filename: notificationPath,
    loaded: true,
    exports: {
      sendNotification: async () => true
    }
  };
  const maps = require('../services/mapService');
  let routeMeters = 10000;
  maps.verifiedRoadRoute = async () => ({
    distanceMeters: routeMeters,
    durationSeconds: 1500,
    polyline: ''
  });
  process.env.JWT_SECRET = 'pricing-integration-test-only';
  const jwt = require('jsonwebtoken');
  const passenger = await User.create({
    name: 'Pricing Passenger',
    phoneNumber: '+923001110001',
    email: 'p@example.test',
    password: 'TestPassword123',
    wallet: {
      balance: 10000
    }
  });
  const other = await User.create({
    name: 'Other Passenger',
    phoneNumber: '+923001110002',
    password: 'TestPassword123'
  });
  const admin = await User.create({
    name: 'Pricing Admin',
    phoneNumber: '+923001110003',
    role: 'admin',
    password: 'TestPassword123'
  });
  const duser = await User.create({
    name: 'Pricing Driver',
    phoneNumber: '+923001110004',
    role: 'driver',
    password: 'TestPassword123'
  });
  const d2user = await User.create({
    name: 'Other Driver',
    phoneNumber: '+923001110005',
    role: 'driver',
    password: 'TestPassword123'
  });
  const driverData = userId => ({
    userId,
    status: 'approved',
    isOnline: true,
    vehicleDetails: {
      type: 'car'
    },
    availability: {
      status: 'available',
      lastUpdated: new Date()
    },
    locationUpdatedAt: new Date(),
    location: {
      type: 'Point',
      coordinates: [67.01, 24.9]
    },
    cashPayablePaisa: 0,
    earningsBalancePaisa: 0
  });
  const driver = await Driver.create(driverData(duser._id)),
    driver2 = await Driver.create(driverData(d2user._id));
  const card = structuredClone(require('../pricing/pilot').find(c => c.category === 'economy'));
  card.status = 'published';
  card.version = 'integration-1';
  card.effectiveFrom = new Date(Date.now() - 60000);
  card.effectiveTo = new Date(Date.now() + 86400000);
  card.policy.surge.mode = 'OFF';
  card.policy.negotiatedEnabled = true;
  const savedCard = await models.RateCard.create(card);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.set('io', {
    to: () => ({
      emit: () => {}
    }),
    emit: () => {}
  });
  app.use('/api/pricing/v2', require('../pricing/routes'));
  app.use('/api/rides', require('../routes/rideRoutes'));
  app.use('/api/payments', require('../routes/paymentRoutes'));
  app.use('/api/drivers', require('../routes/driverRoutes'));
  app.use('/api/admin', require('../routes/adminRoutes'));
  app.use(require('../middleware/errorHandler'));
  const listener = await new Promise(resolve => {
    const l = app.listen(0, '127.0.0.1', () => resolve(l));
  });
  const base = `http://127.0.0.1:${listener.address().port}/api`;
  const call = async (user, method, path, body, key) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + jwt.sign({
          id: String(user._id)
        }, process.env.JWT_SECRET),
        ...(key ? {
          'Idempotency-Key': key
        } : {})
      },
      ...(body === undefined ? {} : {
        body: JSON.stringify(body)
      })
    });
    return {
      status: r.status,
      data: await r.json()
    };
  };
  const route = {
    city: 'karachi',
    category: 'economy',
    pickup: {
      address: 'Pickup',
      coordinates: [67.01, 24.9]
    },
    dropoff: {
      address: 'Dropoff',
      coordinates: [67.11, 24.95]
    }
  };
  const quote = async (mode = 'UPFRONT') => {
    const r = await call(passenger, 'POST', '/pricing/v2/quotes', {
      ...route,
      pricingMode: mode
    });
    assert.equal(r.status, 201, JSON.stringify(r));
    return r.data.quote;
  };
  const book = async (q, k = 'book-' + crypto.randomUUID(), extras = {}) => call(passenger, 'POST', '/rides', {
    quoteId: q._id,
    ...extras
  }, k);
  const readyDriver = async () => {
    await Ride.updateMany({
      status: {
        $in: ['accepted', 'started']
      }
    }, {
      $set: {
        status: 'cancelled'
      }
    });
    return Driver.updateMany({
      _id: {
        $in: [driver._id, driver2._id]
      }
    }, {
      $set: {
        currentRide: null,
        'availability.status': 'available',
        'availability.lastUpdated': new Date(),
        locationUpdatedAt: new Date()
      }
    });
  };
  let q, ride, settledRide, cashRide;
  try {
    await t.test(cases[0], async () => {
      q = await quote();
      assert.equal(q.snapshot.breakdown.passengerTotalPaisa, 50470);
      let r = await call(other, 'POST', '/rides', {
        quoteId: q._id
      }, 'wrong-owner-key');
      assert.equal(r.status, 409);
      r = await book(q, undefined, {
        category: 'bike'
      });
      assert.equal(r.status, 400);
      r = await book(q, undefined, {
        pickup: {
          coordinates: [67.2, 25]
        }
      });
      assert.equal(r.status, 400);
      r = await book(q, undefined, {
        fare: {
          accepted: 1
        }
      });
      assert.equal(r.status, 400);
      const expired = await quote();
      await models.Quote.updateOne({
        _id: expired._id
      }, {
        $set: {
          expiresAt: new Date(0)
        }
      });
      assert.equal((await book(expired)).status, 409);
      const discarded = await quote();
      assert.equal((await call(other, 'DELETE', '/pricing/v2/quotes/' + discarded._id)).status, 404);
      assert.equal((await call(passenger, 'DELETE', '/pricing/v2/quotes/' + discarded._id)).status, 200);
      assert.equal((await book(discarded)).status, 409);
      assert.equal((await call(passenger, 'POST', '/pricing/v2/quotes', {
        ...route,
        city: 'lahore'
      })).status, 422);
    });
    await t.test(cases[1], async () => {
      const key = 'retry-' + crypto.randomUUID();
      const responses = await Promise.all([book(q, key), book(q, key)]);
      assert.ok(responses.every(r => r.status === 201), JSON.stringify(responses));
      assert.equal(responses[0].data.ride._id, responses[1].data.ride._id);
      ride = responses[0].data.ride;
      const consumedDelete = await call(passenger, 'DELETE', '/pricing/v2/quotes/' + q._id);
      assert.equal(consumedDelete.status, 409);
      assert.equal(consumedDelete.data.rideId, ride._id);
      assert.equal(await Ride.countDocuments({
        quoteId: q._id
      }), 1);
      assert.equal((await book(q)).status, 409);
    });
    await t.test(cases[2], async () => {
      const accepted = await Promise.all([call(duser, 'PUT', `/rides/${ride._id}/accept`, {}), call(d2user, 'PUT', `/rides/${ride._id}/accept`, {})]);
      assert.equal(accepted.filter(r => r.status === 200).length, 1);
      await readyDriver();
      const nq = await quote('NEGOTIATED');
      const nr = (await book(nq, undefined, {
        offerPaisa: 49000
      })).data.ride;
      assert.equal((await call(duser, 'POST', `/rides/${nr._id}/offers`, {
        amountPaisa: 1
      })).status, 400);
      const o1 = await call(duser, 'POST', `/rides/${nr._id}/offers`, {
          amountPaisa: 49000
        }),
        o2 = await call(d2user, 'POST', `/rides/${nr._id}/offers`, {
          amountPaisa: 50000
        });
      assert.equal(o1.status, 200);
      assert.equal(o2.status, 200);
      await models.Offer.updateOne({
        _id: o1.data.offer._id
      }, {
        $set: {
          expiresAt: new Date(0)
        }
      });
      assert.equal((await call(passenger, 'POST', `/rides/${nr._id}/select-offer`, {
        offerId: o1.data.offer._id
      })).status, 409);
      await models.Offer.updateOne({
        _id: o1.data.offer._id
      }, {
        $set: {
          expiresAt: new Date(Date.now() + 60000)
        }
      });
      const selected = await Promise.all([call(passenger, 'POST', `/rides/${nr._id}/select-offer`, {
        offerId: o1.data.offer._id
      }), call(passenger, 'POST', `/rides/${nr._id}/select-offer`, {
        offerId: o2.data.offer._id
      })]);
      assert.equal(selected.filter(r => r.status === 200).length, 1);
      assert.equal(await models.Offer.countDocuments({
        rideId: nr._id,
        status: 'active'
      }), 0);
    });
    await t.test(cases[3], async () => {
      await readyDriver();
      const qr = await quote();
      ride = (await book(qr)).data.ride;
      assert.equal((await call(duser, 'PUT', `/rides/${ride._id}/accept`, {})).status, 200);
      assert.equal((await call(other, 'PUT', `/rides/${ride._id}/start`, {})).status, 403);
      assert.equal((await call(duser, 'PUT', `/rides/${ride._id}/start`, {})).status, 409);
      await Driver.updateOne({
        _id: driver._id
      }, {
        $set: {
          locationUpdatedAt: new Date(0)
        }
      });
      assert.equal((await call(duser, 'POST', `/rides/${ride._id}/arrive`, {})).status, 409);
      await Driver.updateOne({
        _id: driver._id
      }, {
        $set: {
          locationUpdatedAt: new Date(),
          location: {
            type: 'Point',
            coordinates: [67.01, 24.9]
          }
        }
      });
      assert.equal((await call(duser, 'POST', `/rides/${ride._id}/arrive`, {})).status, 200);
      assert.equal((await call(duser, 'POST', `/rides/${ride._id}/arrive`, {})).status, 409);
      await Ride.updateOne({
        _id: ride._id
      }, {
        $set: {
          'pickupWaiting.arrivedAt': new Date(Date.now() - 210000)
        }
      });
      assert.equal((await call(duser, 'PUT', `/rides/${ride._id}/start`, {})).status, 200);
      assert.equal((await call(duser, 'PUT', `/rides/${ride._id}/complete`, {
        fare: 1
      })).status, 400);
    });
    await t.test('Route and pass-through proposals need passenger approval; tips/tolls excluded from fees', async () => {
      const source = await Ride.findById(ride._id).lean();
      const adjustable = await Ride.create({
        ...source,
        _id: undefined,
        quoteId: undefined,
        bookingKey: 'adjust-' + crypto.randomUUID(),
        driverId: driver2._id
      });
      routeMeters = 12000;
      let r = await call(d2user, 'POST', '/rides/' + adjustable._id + '/adjustments', {
        kind: 'route',
        dropoff: {
          coordinates: [67.12, 24.96]
        },
        stops: [],
        fare: 1
      });
      assert.equal(r.status, 201, JSON.stringify(r));
      const proposal = r.data.adjustment;
      assert.equal((await Ride.findById(adjustable._id)).pricing.transportFarePaisa, 49000);
      assert.equal((await call(duser, 'PUT', '/rides/' + adjustable._id + '/adjustments/' + proposal.id, {
        approved: true
      })).status, 403);
      r = await call(passenger, 'PUT', '/rides/' + adjustable._id + '/adjustments/' + proposal.id, {
        approved: true
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ride.pricing.transportFarePaisa, 56000);
      assert.equal(r.data.ride.pricingHistory[0].pricing.transportFarePaisa, 49000);
      r = await call(d2user, 'POST', '/rides/' + adjustable._id + '/adjustments', {
        kind: 'passThrough',
        chargeType: 'toll',
        amountPaisa: 10000,
        reason: 'Bridge toll',
        evidence: 'receipt-123'
      });
      assert.equal(r.status, 201);
      const toll = r.data.adjustment;
      assert.equal(toll.breakdown.passThroughPaisa, 10000);
      assert.equal((await call(passenger, 'PUT', '/rides/' + adjustable._id + '/adjustments/' + toll.id, {
        approved: true
      })).status, 200);
      r = await call(d2user, 'POST', '/rides/' + adjustable._id + '/adjustments', {
        kind: 'passThrough',
        chargeType: 'toll',
        amountPaisa: 8000,
        replacesAdjustmentId: toll.id,
        reason: 'Correct actual toll',
        evidence: 'updated-receipt-123'
      });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.adjustment.breakdown.passThroughPaisa, 8000);
      r = await call(passenger, 'PUT', '/rides/' + adjustable._id + '/adjustments/' + r.data.adjustment.id, {
        approved: true
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.ride.receipt.passThroughPaisa, 8000);
      r = await call(passenger, 'POST', '/rides/' + adjustable._id + '/adjustments', {
        kind: 'tip',
        amountPaisa: 1000,
        reason: 'Driver tip'
      });
      assert.equal(r.status, 201);
      r = await call(passenger, 'PUT', '/rides/' + adjustable._id + '/adjustments/' + r.data.adjustment.id, {
        approved: true
      });
      assert.equal(r.status, 200);
      const receipt = r.data.ride.receipt;
      assert.equal(receipt.serviceFeePaisa, require('../pricing/math').bps(receipt.eligibleFarePaisa, 300));
      assert.equal(receipt.passengerTotalPaisa, receipt.eligibleFarePaisa + receipt.serviceFeePaisa + 9000);
      routeMeters = 10000;
    });
    await t.test(cases[4], async () => {
      await models.RateCard.updateOne({
        _id: savedCard._id
      }, {
        $set: {
          'rates.basePaisa': 99000
        }
      });
      await Ride.updateOne({
        _id: ride._id
      }, {
        $set: {
          'tracking.startedAt': new Date(Date.now() - 3600000)
        }
      });
      const r = await call(duser, 'PUT', `/rides/${ride._id}/complete`, {});
      assert.equal(r.status, 200);
      assert.equal(r.data.receipt.transportFarePaisa, 49000);
      assert.ok(r.data.receipt.waitingPaisa >= 250 && r.data.receipt.waitingPaisa < 300);
      assert.equal(r.data.ride.payment.status, 'pending');
      settledRide = r.data.ride;
    });
    await t.test(cases[5], async () => {
      const before = await User.findById(passenger._id).lean();
      const results = await Promise.all(Array.from({
        length: 4
      }, () => call(passenger, 'POST', '/payments/process', {
        rideId: ride._id,
        paymentMethod: 'wallet'
      })));
      assert.ok(results.every(r => r.status === 200), JSON.stringify(results));
      const after = await User.findById(passenger._id).lean();
      assert.equal(before.wallet.balancePaisa - after.wallet.balancePaisa, settledRide.receipt.passengerTotalPaisa);
      assert.equal(await models.Settlement.countDocuments({
        rideId: ride._id
      }), 1);
      assert.equal(await Payment.countDocuments({
        rideId: ride._id,
        type: 'ride'
      }), 1);
      const d = await Driver.findById(driver._id).lean();
      assert.equal(d.earningsBalancePaisa, settledRide.receipt.driverEntitlementPaisa);
    });
    await t.test(cases[6], async () => {
      const rollback = await Ride.create({
        ...settledRide,
        _id: undefined,
        quoteId: undefined,
        bookingKey: 'rollback-' + crypto.randomUUID(),
        payment: {
          status: 'pending'
        }
      });
      await models.Ledger.create({
        key: `settle:${rollback._id}`,
        kind: 'INJECTED_FAILURE'
      });
      const before = await User.findById(passenger._id).lean();
      const r = await call(passenger, 'POST', '/payments/process', {
        rideId: rollback._id,
        paymentMethod: 'wallet'
      });
      assert.notEqual(r.status, 200);
      const after = await User.findById(passenger._id).lean();
      assert.equal(before.wallet.balancePaisa, after.wallet.balancePaisa);
      assert.equal(await models.Settlement.countDocuments({
        rideId: rollback._id
      }), 0);
    });
    await t.test(cases[7], async () => {
      cashRide = await Ride.create({
        ...settledRide,
        _id: undefined,
        quoteId: undefined,
        bookingKey: 'cash-' + crypto.randomUUID(),
        payment: {
          status: 'pending'
        }
      });
      const total = cashRide.receipt.passengerTotalPaisa;
      let r = await call(duser, 'POST', `/rides/${cashRide._id}/cash`, {
        amountPaisa: total
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.settlement.status, 'pending');
      r = await call(passenger, 'POST', `/rides/${cashRide._id}/cash`, {
        amountPaisa: total
      });
      assert.equal(r.status, 200);
      assert.equal(r.data.settlement.status, 'settled');
      const d = await Driver.findById(driver._id).lean();
      assert.equal(d.cashPayablePaisa, cashRide.receipt.platformRevenuePaisa);
      await call(passenger, 'POST', `/rides/${cashRide._id}/cash`, {
        amountPaisa: total
      });
      assert.equal((await Driver.findById(driver._id)).cashPayablePaisa, d.cashPayablePaisa);
    });
    await t.test(cases[8], async () => {
      const key = 'refund-' + crypto.randomUUID();
      const amountPaisa = Math.floor(settledRide.receipt.passengerTotalPaisa / 2);
      const responses = await Promise.all([call(admin, 'POST', `/pricing/v2/admin/rides/${ride._id}/refund`, {
        amountPaisa,
        reason: 'Test partial reversal'
      }, key), call(admin, 'POST', `/pricing/v2/admin/rides/${ride._id}/refund`, {
        amountPaisa,
        reason: 'Test partial reversal'
      }, key)]);
      assert.ok(responses.every(r => r.status === 200));
      assert.equal((await models.Settlement.findOne({
        rideId: ride._id
      })).refundedPaisa, amountPaisa);
      const refundKey = 'cash-refund-key';
      const body = {
        refundKey,
        amountPaisa: cashRide.receipt.passengerTotalPaisa,
        reason: 'Cash returned by driver'
      };
      assert.equal((await call(admin, 'POST', `/pricing/v2/admin/rides/${cashRide._id}/cash-refund`, body)).status, 200);
      assert.equal((await call(duser, 'POST', `/rides/${cashRide._id}/cash-refund`, {
        refundKey
      })).status, 200);
      assert.equal((await models.Settlement.findOne({
        rideId: cashRide._id
      })).refundedPaisa, 0);
      assert.equal((await call(passenger, 'POST', `/rides/${cashRide._id}/cash-refund`, {
        refundKey
      })).status, 200);
      assert.equal((await Driver.findById(driver._id)).cashPayablePaisa, 0);
    });
    await t.test('Cash dispute resolution, fee reconciliation and bank-reference idempotency', async () => {
      const second = await Ride.create({
        ...cashRide.toObject(),
        _id: undefined,
        quoteId: undefined,
        bookingKey: 'cash-dispute-' + crypto.randomUUID(),
        payment: {
          status: 'pending'
        }
      });
      const amountPaisa = second.receipt.passengerTotalPaisa;
      assert.equal((await call(duser, 'POST', '/rides/' + second._id + '/cash', {
        amountPaisa
      })).status, 200);
      const disputed = await call(passenger, 'POST', '/rides/' + second._id + '/cash', {
        amountPaisa,
        disputed: true
      });
      assert.equal(disputed.data.settlement.status, 'disputed');
      assert.equal((await Driver.findById(driver._id)).cashPayablePaisa, 0);
      assert.equal((await call(admin, 'POST', '/pricing/v2/admin/rides/' + second._id + '/resolve-cash', {
        reason: 'Both parties reviewed receipt'
      })).status, 200);
      assert.equal((await call(passenger, 'POST', '/rides/' + second._id + '/cash', {
        amountPaisa
      })).data.settlement.status, 'pending');
      assert.equal((await call(duser, 'POST', '/rides/' + second._id + '/cash', {
        amountPaisa
      })).data.settlement.status, 'settled');
      const receiptAmount = second.receipt.platformRevenuePaisa;
      const path = '/pricing/v2/admin/drivers/' + driver._id + '/reconcile';
      const body = {
        amountPaisa: receiptAmount,
        reference: 'verified-bank-receipt-1'
      };
      assert.equal((await call(admin, 'POST', path, body, 'reconcile-key-1')).status, 200);
      assert.equal((await call(admin, 'POST', path, body, 'reconcile-key-2')).status, 200);
      assert.equal((await Driver.findById(driver._id)).cashPayablePaisa, 0);
    });
    await t.test('Insufficient wallet funds and cancelled rides cannot settle', async () => {
      const poor = await Ride.create({
        ...settledRide,
        _id: undefined,
        quoteId: undefined,
        bookingKey: 'poor-' + crypto.randomUUID(),
        passengerId: other._id,
        payment: {
          status: 'pending'
        }
      });
      assert.equal((await call(other, 'POST', '/payments/process', {
        rideId: String(poor._id),
        paymentMethod: 'wallet'
      })).status, 409);
      assert.equal(await models.Settlement.countDocuments({
        rideId: poor._id
      }), 0);
      await Ride.updateOne({
        _id: poor._id
      }, {
        $set: {
          status: 'cancelled'
        }
      });
      assert.equal((await call(other, 'POST', '/payments/process', {
        rideId: String(poor._id),
        paymentMethod: 'wallet'
      })).status, 409);
    });
    await t.test('Driver payout holds use settled driver account and rejection restores it once', async () => {
      const d = await Driver.findById(driver._id),
        u = await User.findById(duser._id);
      const body = {
        amount: '10.00',
        bankAccount: 'test-account',
        bankName: 'test-bank',
        accountHolder: 'test-holder'
      };
      const key = 'payout-test-key';
      const responses = await Promise.all([call(duser, 'POST', '/drivers/withdraw', body, key), call(duser, 'POST', '/drivers/withdraw', body, key)]);
      assert.ok(responses.every(r => r.status === 200), JSON.stringify(responses));
      const id = responses[0].data.withdrawal._id;
      assert.equal((await Driver.findById(driver._id)).earningsBalancePaisa, d.earningsBalancePaisa - 1000);
      assert.equal((await User.findById(duser._id)).wallet.balancePaisa, u.wallet.balancePaisa);
      assert.equal((await call(admin, 'PUT', '/admin/withdrawals/' + id + '/reject', {
        reason: 'Test return of held funds'
      })).status, 200);
      assert.equal((await call(admin, 'PUT', '/admin/withdrawals/' + id + '/reject', {
        reason: 'Test duplicate'
      })).status, 409);
      assert.equal((await Driver.findById(driver._id)).earningsBalancePaisa, d.earningsBalancePaisa);
    });
    await t.test('No eligible supply and routing failures never create bookable estimates', async () => {
      await readyDriver();
      await Driver.updateMany({}, {
        $set: {
          isOnline: false
        }
      });
      const before = await models.Quote.countDocuments();
      assert.equal((await call(passenger, 'POST', '/pricing/v2/quotes', route)).status, 409);
      await Driver.updateMany({}, {
        $set: {
          isOnline: true
        }
      });
      await Driver.updateMany({}, {
        $set: {
          cashPayablePaisa: card.policy.cashPayableLimitPaisa + 1
        }
      });
      assert.equal((await call(passenger, 'POST', '/pricing/v2/quotes', route)).status, 409);
      await Driver.updateMany({}, {
        $set: {
          cashPayablePaisa: 0
        }
      });
      await User.updateMany({
        _id: {
          $in: [duser._id, d2user._id]
        }
      }, {
        $set: {
          isActive: false
        }
      });
      assert.equal((await call(passenger, 'POST', '/pricing/v2/quotes', route)).status, 409);
      await User.updateMany({
        _id: {
          $in: [duser._id, d2user._id]
        }
      }, {
        $set: {
          isActive: true
        }
      });
      await Driver.updateMany({}, {
        $set: {
          locationUpdatedAt: new Date(0)
        }
      });
      assert.equal((await call(passenger, 'POST', '/pricing/v2/quotes', route)).status, 409);
      await readyDriver();
      const saved = maps.verifiedRoadRoute;
      maps.verifiedRoadRoute = async () => {
        const e = new Error('Routing retry required');
        e.statusCode = 503;
        throw e;
      };
      assert.equal((await call(passenger, 'POST', '/pricing/v2/quotes', route)).status, 503);
      maps.verifiedRoadRoute = saved;
      assert.equal(await models.Quote.countDocuments(), before);
    });
    await t.test('Known provider tolls are disclosed and approved at booking; cancellation charges zero', async () => {
      await readyDriver();
      const saved = maps.verifiedRoadRoute;
      maps.verifiedRoadRoute = async () => ({
        distanceMeters: 10000,
        durationSeconds: 1500,
        knownTollPaisa: 10000,
        hasTolls: true
      });
      const q = await quote();
      assert.equal(q.snapshot.breakdown.passThroughPaisa, 10000);
      assert.equal(q.snapshot.breakdown.serviceFeePaisa, require('../pricing/math').bps(q.snapshot.breakdown.eligibleFarePaisa, 300));
      const booked = await book(q);
      assert.equal(booked.status, 201);
      const priced = booked.data.ride;
      assert.equal(priced.adjustments[0].status, 'approved');
      assert.equal(priced.receipt.passThroughPaisa, 10000);
      assert.equal((await call(d2user, 'PUT', '/rides/' + priced._id + '/accept', {})).status, 200);
      let r = await call(passenger, 'PUT', '/rides/' + priced._id + '/cancel', {});
      assert.equal(r.status, 200);
      assert.equal(r.data.ride.receipt.passengerTotalPaisa, 0);
      assert.equal((await call(passenger, 'POST', '/payments/process', {
        rideId: priced._id,
        paymentMethod: 'wallet'
      })).status, 409);
      maps.verifiedRoadRoute = saved;
    });
    await t.test('Admin revenue and driver earnings report net allocations, not gross passenger fare', async () => {
      const settled = await models.Settlement.find({
        status: 'settled'
      }).lean();
      const netPlatform = settled.reduce((sum, s) => sum + s.allocations.platformRevenuePaisa - (s.refundedAllocations?.platformRevenuePaisa || 0), 0);
      const dashboard = await call(admin, 'GET', '/admin/dashboard');
      assert.equal(dashboard.status, 200, JSON.stringify(dashboard));
      assert.equal(Math.round(dashboard.data.stats.revenue.total * 100), netPlatform);
      const analytics = await call(admin, 'GET', '/admin/analytics/revenue');
      assert.equal(analytics.status, 200);
      assert.equal(Math.round(analytics.data.total * 100), netPlatform);
      const netDriver = settled.filter(s => String(s.driverId) === String(driver._id)).reduce((sum, s) => sum + s.allocations.driverEntitlementPaisa - (s.refundedAllocations?.driverEntitlementPaisa || 0), 0);
      const earnings = await call(duser, 'GET', '/drivers/earnings');
      assert.equal(earnings.status, 200);
      assert.equal(Math.round(earnings.data.earnings.total * 100), netDriver);
    });
    await t.test(cases[9], async () => {
      const draft = {
        ...card,
        version: 'overlap-draft',
        status: 'draft'
      };
      const r = await call(admin, 'POST', '/pricing/v2/admin/cards', draft);
      assert.equal(r.status, 201);
      assert.equal((await call(admin, 'POST', `/pricing/v2/admin/cards/${r.data.card._id}/publish`, {})).status, 409);
      assert.equal((await call(passenger, 'GET', '/pricing/v2/admin/cards')).status, 403);
      await assert.rejects(models.PricingAudit.updateMany({}, {
        $set: {
          action: 'tampered'
        }
      }));
      const c1 = await call(admin, 'POST', '/pricing/v2/admin/cards', {
          ...draft,
          category: 'bike',
          version: 'concurrent-1'
        }),
        c2 = await call(admin, 'POST', '/pricing/v2/admin/cards', {
          ...draft,
          category: 'bike',
          version: 'concurrent-2'
        });
      const pub = await Promise.all([call(admin, 'POST', '/pricing/v2/admin/cards/' + c1.data.card._id + '/publish', {}), call(admin, 'POST', '/pricing/v2/admin/cards/' + c2.data.card._id + '/publish', {})]);
      assert.equal(pub.filter(p => p.status === 200).length, 1);
    });
  } finally {
    await new Promise(resolve => listener.close(resolve));
    assert.match(mongoose.connection.name, /^raftar_pricing_test_[a-f0-9]+$/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
