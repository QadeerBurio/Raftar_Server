const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('crypto');
const security = require('../recovery/security');
test('Pakistan number normalization and password policy', () => {
  for (const v of ['03153440945', '+92 315 3440945', '00923153440945', '923153440945']) assert.equal(security.phone(v), '+923153440945');
  assert.equal(security.phone('+12025550123'), null);
  assert.equal(security.policy(' spaces are allowed '), true);
  assert.equal(security.policy('short'), false);
  assert.equal(security.policy('x'.repeat(73)), false);
});
if (!process.env.PRICING_TEST_URI) test('recovery replica-set integration', {
  skip: 'Run pricing-local-test.js --recovery or set PRICING_TEST_URI explicitly'
}, () => {});else test('Recovery against disposable MongoDB replica set', async t => {
  const mongoose = require('mongoose');
  const dbName = 'raftar_recovery_test_' + crypto.randomBytes(6).toString('hex');
  await mongoose.connect(process.env.PRICING_TEST_URI, {
    dbName,
    autoIndex: false
  });
  t.after(async () => {
    assert.match(mongoose.connection.name, /^raftar_recovery_test_[a-f0-9]+$/);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'recovery-jwt-fixture';
  process.env.RESET_HMAC_SECRET = 'test-only-secret-with-at-least-32-characters';
  process.env.RESET_RESPONSE_FLOOR_MS = '1';
  process.env.RESET_SEND_IP_LIMIT = '1000';
  process.env.RESET_SEND_DESTINATION_LIMIT = '1000';
  process.env.RESET_SEND_ACCOUNT_LIMIT = '1000';
  process.env.RESET_VERIFY_IP_LIMIT = '1000';
  const {
      Challenge,
      Limit
    } = require('../recovery/models'),
    User = require('../models/User');
  for (const m of [Challenge, Limit, User]) await m.createIndexes();
  const migrationUri = process.env.PRICING_TEST_URI.replace(/(mongodb(?:\+srv)?:\/\/[^/]+)(\/[^?]*)?/, '$1/' + dbName);
  const migrated = require('child_process').spawnSync(process.execPath, ['scripts/recovery-migrate.js'], {
    cwd: require('path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      RECOVERY_MIGRATION_URI: migrationUri
    },
    encoding: 'utf8'
  });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  const provider = require('../recovery/provider');
  const deliveries = [];
  let failure = false;
  provider.available = () => true;
  provider.send = async (destination, text) => {
    if (failure) throw Error('Provider test failure');
    deliveries.push({
      destination,
      text
    });
  };
  const legacyMessages = [];
  const twilioPath = require.resolve('twilio');
  require(twilioPath);
  require.cache[twilioPath].exports = () => ({
    messages: {
      create: async payload => {
        legacyMessages.push(payload);
        return {
          sid: 'test-provider-accepted'
        };
      }
    }
  });
  const express = require('express'),
    app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/authRoutes'));
  app.get('/protected', require('../middleware/auth'), (req, res) => res.json({
    ok: true
  }));
  app.use(require('../middleware/errorHandler'));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, body, token) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {
          Authorization: 'Bearer ' + token
        } : {})
      },
      body: JSON.stringify(body)
    });
    return {
      status: r.status,
      data: await r.json()
    };
  };
  const route = (path, body) => call('/api/auth/' + path, body);
  const unlock = () => Limit.updateMany({
    _id: /^cooldown:/
  }, {
    $set: {
      expiresAt: new Date(0)
    }
  });
  const revoked = [];
  const stopRevocation = require('../recovery/sessionRevocation').start({
    in: room => ({
      disconnectSockets: () => revoked.push(room)
    })
  });
  t.after(stopRevocation);
  const user = await User.create({
    name: 'Recovery test',
    phoneNumber: '+923001234567',
    email: 'test@example.test',
    isVerified: true,
    password: 'old password 123'
  });
  const unverified = await User.create({
    name: 'Not verified',
    phoneNumber: '+923001234568',
    password: 'old password 123'
  });
  const send = async (destination = user.phoneNumber) => {
    await unlock();
    const r = await route('forgot-password', {
      destination
    });
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.data;
  };
  const otpFor = () => deliveries.at(-1).text.match(/\b\d{6}\b/)[0];
  const verify = async c => {
    const r = await route('verify-reset-otp', {
      challengeId: c.challengeId,
      otp: otpFor()
    });
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.data.resetToken;
  };
  let current, token;
  await t.test('unknown and unverified channels receive neutral responses without delivery', async () => {
    const before = deliveries.length;
    const a = await send('+923001234569'),
      b = await send(unverified.phoneNumber),
      c = await send(user.email);
    assert.equal(deliveries.length, before);
    for (const r of [a, b, c]) {
      assert.equal(r.message, 'If an eligible account exists, a code has been sent.');
      assert.equal(r.otp, undefined);
      assert.ok(r.maskedDestination);
    }
  });
  await t.test('real provider failure is 503 and failed codes cannot verify', async () => {
    failure = true;
    await unlock();
    const r = await route('forgot-password', {
      destination: user.phoneNumber
    });
    assert.equal(r.status, 503);
    failure = false;
  });
  await t.test('send persists only keyed OTP hashes and enforces cooldown', async () => {
    current = await send('03001234567');
    const row = await Challenge.findById(current.challengeId).lean();
    assert.equal(row.otp, undefined);
    assert.equal(row.otpHash.length, 64);
    assert.equal(row.otpHash.includes(otpFor()), false);
    assert.equal((await route('resend-reset-otp', {
      challengeId: current.challengeId
    })).status, 429);
  });
  await t.test('five wrong guesses lock challenge; correct sixth guess fails', async () => {
    const correct = otpFor();
    for (let i = 0; i < 5; i++) assert.equal((await route('verify-reset-otp', {
      challengeId: current.challengeId,
      otp: correct === '000000' ? '999999' : '000000'
    })).status, 400);
    assert.equal((await route('verify-reset-otp', {
      challengeId: current.challengeId,
      otp: correct
    })).status, 400);
  });
  await t.test('expired OTP fails; resend invalidates old challenge and concurrent resend has one winner', async () => {
    current = await send();
    const old = otpFor();
    await Challenge.updateOne({
      _id: current.challengeId
    }, {
      $set: {
        expiresAt: new Date(0)
      }
    });
    assert.equal((await route('verify-reset-otp', {
      challengeId: current.challengeId,
      otp: old
    })).status, 400);
    await unlock();
    const results = await Promise.all([route('resend-reset-otp', {
      challengeId: current.challengeId
    }), route('resend-reset-otp', {
      challengeId: current.challengeId
    })]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(results.filter(r => r.status === 429).length, 1);
    assert.equal((await route('verify-reset-otp', {
      challengeId: current.challengeId,
      otp: old
    })).status, 400);
    current = results.find(r => r.status === 200).data;
  });
  await t.test('concurrent correct verification issues one single-use token', async () => {
    const code = otpFor();
    const results = await Promise.all([route('verify-reset-otp', {
      challengeId: current.challengeId,
      otp: code
    }), route('verify-reset-otp', {
      challengeId: current.challengeId,
      otp: code
    })]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    token = results.find(r => r.status === 200).data.resetToken;
    const row = await Challenge.findById(current.challengeId).lean();
    assert.equal(row.otpHash, undefined);
    assert.notEqual(row.tokenHash, token);
    assert.equal(row.tokenHash.length, 64);
  });
  await t.test('phone/OTP alone, mismatches and policy failures cannot reset', async () => {
    assert.equal((await route('reset-password', {
      phoneNumber: user.phoneNumber,
      otp: otpFor(),
      newPassword: 'new password 123'
    })).status, 400);
    assert.equal((await route('reset-password', {
      resetToken: token,
      newPassword: 'short',
      confirmPassword: 'short'
    })).status, 400);
    assert.equal((await route('reset-password', {
      resetToken: token,
      newPassword: 'new password 123',
      confirmPassword: 'different'
    })).status, 400);
  });
  await t.test('expired and wrong-purpose reset tokens rejected', async () => {
    await Challenge.updateOne({
      _id: current.challengeId
    }, {
      $set: {
        tokenExpiresAt: new Date(0)
      }
    });
    const body = {
      resetToken: token,
      newPassword: 'new password 123',
      confirmPassword: 'new password 123'
    };
    assert.equal((await route('reset-password', body)).status, 400);
    await Challenge.updateOne({
      _id: current.challengeId
    }, {
      $set: {
        tokenExpiresAt: new Date(Date.now() + 300000),
        purpose: 'login'
      }
    });
    assert.equal((await route('reset-password', body)).status, 400);
    await Challenge.updateOne({
      _id: current.challengeId
    }, {
      $set: {
        purpose: 'password-reset'
      }
    });
  });
  await t.test('one concurrent reset succeeds, password hashed once and old access/refresh sessions fail', async () => {
    const oldLoginCodeResponse = await route('send-otp', {
      phoneNumber: user.phoneNumber
    });
    assert.equal(oldLoginCodeResponse.status, 200);
    const oldLoginCode = legacyMessages.at(-1).body.match(/\b\d{6}\b/)[0];
    assert.equal(JSON.stringify(oldLoginCodeResponse.data).includes(oldLoginCode), false);
    const oldSession = require('../utils/helpers').generateToken(user._id, 0);
    const body = {
      resetToken: token,
      newPassword: 'new password 123',
      confirmPassword: 'new password 123'
    };
    const results = await Promise.all([route('reset-password', body), route('reset-password', body)]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal((await route('reset-password', body)).status, 400);
    const fresh = await User.findById(user._id);
    assert.equal(await fresh.comparePassword('new password 123'), true);
    assert.equal(await fresh.comparePassword('old password 123'), false);
    assert.equal(fresh.tokenVersion, 1);
    assert.equal((await route('verify-otp', {
      phoneNumber: user.phoneNumber,
      otp: oldLoginCode
    })).status, 400);
    assert.equal((await route('send-otp', {
      phoneNumber: '03001234567'
    })).status, 200);
    const freshLoginCode = legacyMessages.at(-1).body.match(/\b\d{6}\b/)[0];
    assert.equal((await route('verify-otp', {
      phoneNumber: '03001234567',
      otp: freshLoginCode
    })).status, 200);
    for (let i = 0; i < 40 && !revoked.includes('user-' + user._id); i++) await new Promise(r => setTimeout(r, 25));
    assert.ok(revoked.includes('user-' + user._id), 'MongoDB change stream revokes realtime sessions');
    assert.equal((await route('refresh-token', {
      token: oldSession
    })).status, 401);
    assert.equal((await fetch(base + '/protected', {
      headers: {
        Authorization: 'Bearer ' + oldSession
      }
    })).status, 401);
    const login = await route('login', {
      phoneNumber: '03001234567',
      password: 'new password 123'
    });
    assert.equal(login.status, 200);
    assert.equal((await fetch(base + '/protected', {
      headers: {
        Authorization: 'Bearer ' + login.data.token
      }
    })).status, 200);
    assert.equal((await route('login', {
      phoneNumber: user.phoneNumber,
      password: 'old password 123'
    })).status, 401);
  });
  await t.test('suspended verified accounts remain suspended after reset', async () => {
    await User.updateOne({
      _id: user._id
    }, {
      $set: {
        isActive: false
      }
    });
    current = await send();
    const tkn = await verify(current);
    assert.equal((await route('reset-password', {
      resetToken: tkn,
      newPassword: 'another password',
      confirmPassword: 'another password'
    })).status, 200);
    assert.equal((await User.findById(user._id)).isActive, false);
    assert.equal((await route('login', {
      phoneNumber: user.phoneNumber,
      password: 'another password'
    })).status, 403);
  });
  await t.test('resend invalidates verified tokens and races safely with verification', async () => {
    let c = await send();
    let old = await verify(c);
    await unlock();
    let r = await route('resend-reset-otp', {
      challengeId: c.challengeId
    });
    assert.equal(r.status, 200);
    assert.equal((await route('reset-password', {
      resetToken: old,
      newPassword: 'should not work',
      confirmPassword: 'should not work'
    })).status, 400);
    c = r.data;
    const code = otpFor();
    await unlock();
    const results = await Promise.all([route('verify-reset-otp', {
      challengeId: c.challengeId,
      otp: code
    }), route('resend-reset-otp', {
      challengeId: c.challengeId
    })]);
    assert.equal(results[1].status, 200);
    if (results[0].status === 200) assert.equal((await route('reset-password', {
      resetToken: results[0].data.resetToken,
      newPassword: 'should not work',
      confirmPassword: 'should not work'
    })).status, 400);
    assert.equal((await route('verify-reset-otp', {
      challengeId: results[1].data.challengeId,
      otp: otpFor()
    })).status, 200);
  });
  await t.test('destination and account send budgets are independently enforced', async () => {
    process.env.RESET_SEND_DESTINATION_LIMIT = '1';
    await send('+923221234567');
    await unlock();
    assert.equal((await route('forgot-password', {
      destination: '+923221234567'
    })).status, 429);
    process.env.RESET_SEND_DESTINATION_LIMIT = '1000';
    process.env.RESET_SEND_ACCOUNT_LIMIT = '1';
    await unlock();
    assert.equal((await route('forgot-password', {
      destination: user.phoneNumber
    })).status, 429);
    process.env.RESET_SEND_ACCOUNT_LIMIT = '1000';
  });
  await t.test('verified email works, changing email clears verification, notifier failure never logs secrets', async () => {
    await User.updateOne({
      _id: user._id
    }, {
      $set: {
        emailVerified: true
      }
    });
    const c = await send(user.email);
    const code = otpFor();
    const tk = await verify(c);
    const logs = [];
    const mock = t.mock.method(console, 'warn', (...args) => logs.push(args));
    failure = true;
    const r = await route('reset-password', {
      resetToken: tk,
      newPassword: ' email changed password ',
      confirmPassword: ' email changed password '
    });
    failure = false;
    assert.equal(r.status, 200);
    const printed = JSON.stringify(logs);
    for (const secret of [code, tk, ' email changed password ']) assert.equal(printed.includes(secret), false);
    mock.mock.restore();
    const u = await User.findById(user._id);
    u.email = 'different@example.test';
    await u.save();
    assert.equal(u.emailVerified, false);
  });
  await t.test('IP/destination limits enforced and sensitive values never echoed', async () => {
    process.env.RESET_SEND_IP_LIMIT = '1';
    assert.equal((await route('forgot-password', {
      destination: '+923007654321'
    })).status, 429);
    process.env.RESET_SEND_IP_LIMIT = '1000';
    const r = await route('reset-password', {
      resetToken: 'x'.repeat(43),
      newPassword: 'secret password',
      confirmPassword: 'mismatch'
    });
    const malformed = await fetch(base + '/api/auth/reset-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{\"newPassword\":\"secret password\",'
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes('secret password'), false);
    assert.equal(JSON.stringify(r.data).includes('secret password'), false);
    assert.equal(JSON.stringify(r.data).includes('x'.repeat(43)), false);
  });
});
