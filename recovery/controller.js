const crypto = require('crypto'),
  mongoose = require('mongoose');
const {
    Challenge,
    Limit,
    Notice
  } = require('./models'),
  User = require('../models/User'),
  security = require('./security'),
  provider = require('./provider');
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), {
    statusCode
  });
};
const setting = (name, fallback) => {
  const n = Number(process.env[name] || fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const tx = async fn => {
  const s = await mongoose.startSession();
  try {
    let result;
    await s.withTransaction(async () => {
      result = await fn(s);
    });
    return result;
  } finally {
    await s.endSession();
  }
};
async function rate(key, max, windowSeconds = 3600) {
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const id = security.hash('limit', key + ':' + bucket);
  let entry;
  try {
    entry = await Limit.findOneAndUpdate({
      _id: id
    }, {
      $inc: {
        count: 1
      },
      $setOnInsert: {
        expiresAt: new Date((bucket + 2) * windowSeconds * 1000)
      }
    }, {
      upsert: true,
      returnDocument: 'after'
    });
  } catch (e) {
    if (e.code !== 11000) throw e;
    entry = await Limit.findOneAndUpdate({
      _id: id
    }, {
      $inc: {
        count: 1
      }
    }, {
      returnDocument: 'after'
    });
  }
  if (entry.count > max) fail('Too many recovery requests. Please try later.', 429);
}
async function sendLimit(req, dest) {
  await rate('ip:' + req.ip, setting('RESET_SEND_IP_LIMIT', 20));
  await rate('destination:' + dest, setting('RESET_SEND_DESTINATION_LIMIT', 5));
}
const view = c => ({
  success: true,
  message: 'If an eligible account exists, a code has been sent.',
  challengeId: String(c._id),
  maskedDestination: security.mask(c.destination),
  serverNow: new Date().toISOString(),
  expiresAt: c.expiresAt,
  resendAt: c.resendAt
});
function eligible(user, dest) {
  return user && (dest.includes('@') && user.emailVerified === true && user.email === dest || !dest.includes('@') && user.isVerified === true && security.phone(user.phoneNumber) === dest);
}
async function send(c, otp) {
  if (!c.account) return;
  try {
    await provider.send(c.destination, `Your Raftar password reset code is ${otp}. It expires in ${setting('RESET_OTP_SECONDS', 300)} seconds. Do not share it.`);
  } catch (e) {
    await Challenge.updateOne({
      _id: c._id,
      otpHash: c.otpHash
    }, {
      $set: {
        state: 'delivery_failed'
      },
      $unset: {
        otpHash: 1
      }
    });
    fail('Recovery delivery is unavailable. Please try later.', 503);
  }
}
exports.forgot = async (req, res) => {
  const start = Date.now();
  try {
    if (!provider.available()) fail('Recovery delivery is unavailable. Please try later.', 503);
    const dest = security.destination(req.body?.destination || req.body?.phoneNumber || req.body?.email);
    if (!dest) fail('Enter a valid Pakistan mobile number or email.');
    if (!provider.available(dest)) fail('Recovery delivery is unavailable. Please try later.', 503);
    await sendLimit(req, dest);
    const variants = dest.includes('@') ? {
      email: dest
    } : {
      phoneNumber: {
        $in: [dest, '0' + dest.slice(3), dest.slice(1), '0092' + dest.slice(3)]
      }
    };
    const matches = await User.find(variants).limit(2);
    const user = matches.length === 1 && eligible(matches[0], dest) ? matches[0] : null;
    if (user) await rate('account:' + user.id, setting('RESET_SEND_ACCOUNT_LIMIT', 5));
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0'),
      id = crypto.randomBytes(24).toString('hex');
    const c = await tx(async session => {
      const now = new Date(),
        key = security.hash('destination', dest);
      const gate = await Limit.findOneAndUpdate({
        _id: 'cooldown:' + key,
        expiresAt: {
          $lte: now
        }
      }, {
        $set: {
          expiresAt: new Date(Date.now() + setting('RESET_COOLDOWN_SECONDS', 60) * 1000)
        }
      }, {
        session,
        returnDocument: 'after'
      });
      if (!gate) {
        try {
          await Limit.create([{
            _id: 'cooldown:' + key,
            count: 0,
            expiresAt: new Date(Date.now() + setting('RESET_COOLDOWN_SECONDS', 60) * 1000)
          }], {
            session
          });
        } catch (e) {
          if (e.code === 11000) fail('Please wait before requesting another code.', 429);
          throw e;
        }
      }
      await Challenge.updateMany({
        destinationKey: key,
        state: {
          $in: ['pending', 'verified']
        }
      }, {
        $set: {
          state: 'invalidated'
        },
        $unset: {
          otpHash: 1,
          tokenHash: 1
        }
      }, {
        session
      });
      const [c] = await Challenge.create([{
        _id: id,
        account: user?._id,
        destination: dest,
        destinationKey: key,
        purpose: 'password-reset',
        version: user?.tokenVersion || 0,
        otpHash: security.hash('otp', id + ':' + otp),
        expiresAt: new Date(Date.now() + setting('RESET_OTP_SECONDS', 300) * 1000),
        resendAt: new Date(Date.now() + setting('RESET_COOLDOWN_SECONDS', 60) * 1000)
      }], {
        session
      });
      return c;
    });
    await send(c, otp);
    const delay = setting('RESET_RESPONSE_FLOOR_MS', 1200) - (Date.now() - start);
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    res.json(view(c));
  } finally {
    const left = setting('RESET_RESPONSE_FLOOR_MS', 1200) - (Date.now() - start);
    if (left > 0) await new Promise(r => setTimeout(r, left));
  }
};
exports.resend = async (req, res) => {
  if (!provider.available()) fail('Recovery delivery is unavailable. Please try later.', 503);
  const old = security.validChallenge(req.body?.challengeId) && (await Challenge.findById(req.body.challengeId));
  if (!old || old.purpose !== 'password-reset') fail('Recovery challenge unavailable. Start again.');
  // Starting a new challenge enforces the same account/IP/destination limits and atomic cooldown.
  req.body = {
    destination: old.destination
  };
  return exports.forgot(req, res);
};
exports.verify = async (req, res) => {
  await rate('verify-ip:' + req.ip, setting('RESET_VERIFY_IP_LIMIT', 100));
  const {
    challengeId,
    otp
  } = req.body || {};
  if (!security.validChallenge(challengeId) || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) fail('Enter the six-digit code.');
  const token = crypto.randomBytes(32).toString('base64url');
  const result = await tx(async session => {
    const c = await Challenge.findById(challengeId).session(session);
    if (!c || c.purpose !== 'password-reset' || c.state !== 'pending' || c.expiresAt <= new Date() || c.attempts >= 5) return null;
    c.attempts++;
    const supplied = security.hash('otp', challengeId + ':' + otp),
      valid = c.account && crypto.timingSafeEqual(Buffer.from(c.otpHash || '', 'hex'), Buffer.from(supplied, 'hex'));
    if (!valid) {
      if (c.attempts >= 5) {
        c.state = 'locked';
        c.otpHash = undefined;
      }
      await c.save({
        session
      });
      return null;
    }
    c.state = 'verified';
    c.otpHash = undefined;
    c.tokenHash = security.hash('reset-token', token);
    c.tokenExpiresAt = new Date(Date.now() + setting('RESET_TOKEN_SECONDS', 300) * 1000);
    await c.save({
      session
    });
    return {
      expiresAt: c.tokenExpiresAt
    };
  });
  if (!result) fail('Invalid or expired code. Request a new code if needed.');
  res.json({
    success: true,
    resetToken: token,
    expiresAt: result.expiresAt,
    serverNow: new Date().toISOString()
  });
};
exports.reset = async (req, res) => {
  const {
    resetToken,
    newPassword,
    confirmPassword
  } = req.body || {};
  if (typeof resetToken !== 'string' || resetToken.length !== 43) fail('A verified password-reset token is required.');
  if (!security.policy(newPassword)) fail('Use at least 6 characters and no more than 72 UTF-8 bytes.');
  if (newPassword !== confirmPassword) fail('Passwords do not match.');
  await rate('reset-ip:' + req.ip, setting('RESET_VERIFY_IP_LIMIT', 100));
  const dest = await tx(async session => {
    const c = await Challenge.findOne({
      tokenHash: security.hash('reset-token', resetToken),
      purpose: 'password-reset',
      state: 'verified',
      tokenExpiresAt: {
        $gt: new Date()
      }
    }).session(session);
    if (!c) fail('Reset token expired or already used. Start again.');
    const user = await User.findById(c.account).session(session);
    if (!eligible(user, c.destination) || (user.tokenVersion || 0) !== c.version) fail('Recovery authorization is no longer valid. Start again.');
    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save({
      session
    });
    await Challenge.updateMany({
      account: user._id
    }, {
      $set: {
        state: 'consumed'
      },
      $unset: {
        otpHash: 1,
        tokenHash: 1
      }
    }, {
      session
    });
    const [notice] = await Notice.create([{
      account: user._id,
      destination: c.destination
    }], {
      session
    });
    return {
      noticeId: String(notice._id),
      destination: c.destination,
      userId: String(user._id)
    };
  });
  require('../services/smsService').invalidateOTP?.(dest.destination);
  req.app.get('io')?.in('user-' + dest.userId).disconnectSockets(true);
  let notified = false;
  try {
    notified = await require('./notices').deliver(dest.noticeId);
  } catch (e) {
    console.warn('Password-changed notice remains pending');
  }
  res.json({
    success: true,
    message: 'Password reset successfully. Please sign in with your new password.',
    notificationPending: !notified
  });
};
exports.rate = rate;
