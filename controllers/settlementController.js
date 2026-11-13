const mongoose = require('mongoose');
const Ride = require('../models/Ride');
const User = require('../models/User');
const Payment = require('../models/Payment');

exports.processPayment = async (req, res, next) => {
  const { rideId, paymentMethod } = req.body;
  if (mongoose.isValidObjectId(rideId)) {
    const ride = await Ride.findById(rideId);
    if (ride?.pricing) return require('../pricing/settlement').settle(req, res, next);
  }
  if (paymentMethod !== 'wallet') {
    return res.status(501).json({ error: 'This endpoint supports wallet ride payments. External payments and cash require provider or driver confirmation.' });
  }
  if (!mongoose.isValidObjectId(rideId)) return res.status(400).json({ error: 'Valid rideId required' });
  const session = await mongoose.startSession();
  try {
    let payment;
    await session.withTransaction(async () => {
      const ride = await Ride.findOne({ _id: rideId, passengerId: req.user.id }).session(session);
      const fail = (statusCode, message) => { const error = new Error(message); error.statusCode = statusCode; throw error; };
      if (!ride) fail(404, 'Ride not found');
      if (ride.status !== 'completed') fail(400, 'Ride must be completed before payment');
      if (['paid', 'covered_by_subscription'].includes(ride.payment?.status)) fail(409, 'Ride is already paid');
      const amount = ride.fare?.final;
      if (!Number.isFinite(amount) || amount <= 0) fail(400, 'Ride has no valid final fare');
      const user = await User.findOneAndUpdate({ _id: req.user.id, 'wallet.balance': { $gte: amount } }, { $inc: { 'wallet.balance': -amount, 'wallet.balancePaisa': -require('../pricing/math').money(amount) } }, { new: true, session });
      if (!user) fail(400, 'Insufficient wallet balance');
      [payment] = await Payment.create([{ userId: req.user.id, rideId, amount, type: 'ride', paymentMethod: 'wallet', status: 'completed', completedAt: new Date() }], { session });
      ride.payment = { method: 'wallet', status: 'paid', amount, transactionId: String(payment._id) };
      await ride.save({ session });
    });
    res.json({ success: true, payment, message: 'Wallet payment completed' });
  } catch (error) {
    next(error);
  } finally {
    await session.endSession();
  }
};
