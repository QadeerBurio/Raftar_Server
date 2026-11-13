const assert = require('node:assert/strict');
const express = require('express');
const User = require('../models/User');
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res, next) => { req.user = { id: '507f1f77bcf86cd799439011', role: 'passenger' }; next(); } };
const app = express();
app.use(express.json());
app.use('/auth', require('../routes/authRoutes'));
app.use('/users', require('../routes/userRoutes'));
app.use('/notifications', require('../routes/notificationRoutes'));
app.use('/payments', require('../routes/paymentRoutes'));
let writes = 0;
User.findOne = async () => null;
User.prototype.save = async function () { writes++; this.isActive = true; return this; };
process.env.JWT_SECRET = 'audit-test-secret';
const listener = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${listener.address().port}`;
  const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  try {
    let r = await post('/auth/register', { name: 'Test', phoneNumber: '+923001234567', password: 'TestPass123', role: 'admin' });
    assert.equal(r.status, 400); assert.equal(writes, 0);
    r = await post('/auth/admin/register', { name: 'Test', phoneNumber: '+923001234567', email: 'test@example.com', password: 'TestPass123', role: 'passenger' });
    assert.equal(r.status, 201); assert.equal(r.body.user.role, 'admin'); assert.equal(writes, 1);
    r = await post('/payments/wallet/add', { amount: 100 }); assert.equal(r.status, 501);
    r = await post('/payments/create-intent', { amount: -100, paymentMethod: 'stripe' }); assert.equal(r.status, 400);
    r = await post('/payments/process', { rideId: 'bad-id', paymentMethod: 'wallet' }); assert.equal(r.status, 400);
    r = await post('/payments/process', { paymentMethod: 'cash' }); assert.equal(r.status, 501);
    const Notification = require('../models/Notification');
    Notification.findOneAndUpdate = async filter => { assert.equal(filter.userId, '507f1f77bcf86cd799439011'); return null; };
    let response = await fetch(base + '/notifications/507f1f77bcf86cd799439012/read', { method: 'PUT' }); assert.equal(response.status, 404);
    const auth = require('../controllers/authController');
    User.findOne = async () => ({ role: 'passenger', isActive: true, comparePassword: async () => true });
    r = await post('/auth/login', { email: 'test@example.com', password: 'TestPass123', role: 'admin' }); assert.equal(r.status, 403);
    assert.ok(auth.register);
    console.log('PASS: public role restriction, dedicated admin registration, portal role check, fake funding prevention, invalid payment rejection');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { listener.close(); process.exit(process.exitCode || 0); }
});
