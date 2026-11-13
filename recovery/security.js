const crypto = require('crypto');
function phone(value) {
  const s = String(value || '').replace(/[\s()-]/g, '');
  const n = s.startsWith('0092') ? '+' + s.slice(2) : /^923\d{9}$/.test(s) ? '+' + s : s.startsWith('03') ? '+92' + s.slice(1) : /^3\d{9}$/.test(s) ? '+92' + s : s;
  return /^\+923\d{9}$/.test(n) ? n : null;
}
function destination(value) {
  const p = phone(value);
  if (p) return p;
  const e = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}
function secret() {
  const s = process.env.RESET_HMAC_SECRET;
  if (!s || s.length < 32) throw Object.assign(new Error('Password recovery is unavailable'), {
    statusCode: 503
  });
  return s;
}
const hash = (purpose, value) => crypto.createHmac('sha256', secret()).update(purpose + ':' + value).digest('hex');
const policy = password => typeof password === 'string' && password.length >= 6 && Buffer.byteLength(password, 'utf8') <= 72;
const mask = d => d.includes('@') ? d.slice(0, 1) + '***@' + d.split('@')[1] : d.slice(0, 3) + '******' + d.slice(-4);
const validChallenge = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);
const phoneVariants = value => {
  const p = phone(value);
  return p ? [p, '0' + p.slice(3), p.slice(1), '0092' + p.slice(3)] : [value];
};
module.exports = {
  phoneVariants,
  validChallenge,
  phone,
  destination,
  hash,
  policy,
  mask
};
