const cron = require('node-cron');
const mongoose = require('mongoose');
const Ride = require('../models/Ride');
const {
  sendNotification
} = require('../services/notificationService');
module.exports = io => cron.schedule('*/5 * * * * *', async () => {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const rides = await Ride.find({
      status: 'accepted',
      'pickupWaiting.authorized': true,
      'pickupWaiting.warningSent': false,
      'pickupWaiting.arrivedAt': {
        $ne: null
      },
      pricing: {
        $exists: true
      }
    }).limit(100);
    for (const ride of rides) {
      const warningAt = +ride.pickupWaiting.arrivedAt + (ride.pricing.policy.freeWaitingSeconds - ride.pricing.policy.waitingNoticeSeconds) * 1000;
      if (Date.now() < warningAt) continue;
      const result = await Ride.updateOne({
        _id: ride._id,
        status: 'accepted',
        'pickupWaiting.warningSent': false
      }, {
        $set: {
          'pickupWaiting.warningSent': true
        }
      });
      if (!result.modifiedCount) continue;
      const message = 'Free pickup waiting is ending soon. Paid waiting is prorated by seconds after the free period.';
      io.to(`ride-${ride._id}`).emit('waiting-warning', {
        rideId: ride._id,
        message
      });
      await sendNotification(ride.passengerId, 'system', {
        title: 'Pickup waiting',
        body: message
      });
    }
  } catch (e) {
    console.warn('[pricing] waiting notification check failed:', e.message);
  }
});
