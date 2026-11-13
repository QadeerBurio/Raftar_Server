const cron = require('node-cron');
const mongoose = require('mongoose');
const Ride = require('./models/Ride');
const User = require('./models/User'); // if needed
const Driver = require('./models/Driver'); // if needed

const startCronJobs = (io) => {
  require('./pricing/waiting')(io);
  require('./recovery/notices').start();
  // Check every minute
  cron.schedule('* * * * *', async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      const now = new Date();
      const in15Minutes = new Date(now.getTime() + 15 * 60 * 1000);

      const rides = await Ride.find({
        type: { $in: ['intercity', 'carpool'] },
        status: { $in: ['scheduled', 'accepted'] },
        reminderSent: false,
        scheduledTime: { $gt: now, $lte: in15Minutes }
      }).populate('driverId');

      for (const ride of rides) {
        // Send to passenger
        io.to(`user-${ride.passengerId.toString()}`).emit('ride-reminder', {
          rideId: ride._id,
          message: `Reminder: Your ${ride.type} ride is scheduled to start in less than 15 minutes.`
        });

        // Send to driver if assigned
        if (ride.driverId) {
          const driverUserId = ride.driverId.userId ? ride.driverId.userId.toString() : ride.driverId.toString();
          io.to(`user-${driverUserId}`).emit('ride-reminder', {
            rideId: ride._id,
            message: `Reminder: Your ${ride.type} ride is scheduled to start in less than 15 minutes.`
          });
        }

        // Mark as sent
        ride.reminderSent = true;
        await ride.save();
        console.log(`Sent 15-minute reminder for ride ${ride._id}`);
      }
    } catch (error) {
      console.error('Error in cron job for ride reminders:', error);
    }
  });

  // 2-Hour Subscription Ride Activation
  cron.schedule('* * * * *', async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      const now = new Date();
      // Target exactly 2 hours from now. $lte catches it if it missed a minute due to server lag.
      const exactlyTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      const ridesToActivate = await Ride.find({
        type: 'carpool-subscription',
        status: 'scheduled',
        scheduledTime: { $lte: exactlyTwoHours }
      });

      if (ridesToActivate.length > 0) {
        console.log(`[Cron 2-Hour Activation] Found ${ridesToActivate.length} subscription ride(s) scheduled on or before ${exactlyTwoHours.toISOString()}`);
      }

      for (const ride of ridesToActivate) {
        // Transition to accepted (the active pre-start state for Raftar rides)
        ride.status = 'accepted';
        await ride.save();

        // Safely extract driver User ID for socket room
        let driverUserId = null;
        if (ride.driverId) {
          const driverDoc = await Driver.findById(ride.driverId);
          if (driverDoc && driverDoc.userId) {
            driverUserId = driverDoc.userId.toString();
          } else {
            driverUserId = ride.driverId.toString();
          }
        }

        // Notify passenger
        const passengerRoom = `user-${ride.passengerId.toString()}`;
        io.to(passengerRoom).emit('ride-updated', {
          rideId: ride._id,
          status: 'accepted',
          message: 'Your scheduled subscription ride is now active.'
        });
        console.log(`[Cron 2-Hour Activation] Emitted ride-updated to passenger room: ${passengerRoom}`);

        // Notify driver
        if (driverUserId) {
          const driverRoom = `user-${driverUserId}`;
          io.to(driverRoom).emit('ride-updated', {
            rideId: ride._id,
            status: 'accepted',
            message: 'Your scheduled subscription ride is now active.'
          });
          console.log(`[Cron 2-Hour Activation] Emitted ride-updated to driver room: ${driverRoom}`);
        }

        console.log(`[Cron 2-Hour Activation] Successfully activated subscription ride ${ride._id} (Scheduled: ${ride.scheduledTime.toISOString()})`);
      }
    } catch (error) {
      console.error('Error in cron job for subscription activation:', error);
    }
  });

  // Subscription Auto-Resolve Abandoned Rides (Runs every 5 minutes)
  cron.schedule('*/5 * * * *', async () => {
    if (mongoose.connection.readyState !== 1) return;
    try {
      const now = new Date();
      // If a ride is still 'accepted' 1 hour past its scheduled time, it is abandoned by the driver
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const abandonedRides = await Ride.find({
        type: 'carpool-subscription',
        status: 'accepted',
        scheduledTime: { $lte: oneHourAgo }
      });

      if (abandonedRides.length > 0) {
        const { completeSubscriptionRide } = require('./controllers/subscriptionController');
        
        for (const ride of abandonedRides) {
          // If neither party reported absent, assume the ride was completed successfully
          const mockReq = { app: { get: () => io } };
          const mockRes = { status: () => mockRes, json: () => {} };
          
          await completeSubscriptionRide(mockReq, mockRes, ride);
          console.log(`Auto-resolved abandoned subscription ride ${ride._id} as Completed`);
        }
      }
    } catch (error) {
      console.error('Error in cron job for auto-resolving rides:', error);
    }
  });

  console.log('Cron jobs initialized.');
};

module.exports = startCronJobs;
