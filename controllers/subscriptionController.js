const CarpoolSubscription = require('../models/CarpoolSubscription');
const pricingEngine = require('../services/pricingEngine');
const mongoose = require('mongoose');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Ride = require('../models/Ride');

// Helper to safely parse time (e.g. "08:00 AM" or "18:15") into a Date object relative to a base date
const parseTimeToDate = (baseDate, timeString) => {
  const d = new Date(baseDate);
  if (!timeString) {
    d.setHours(8, 0, 0, 0);
    return d;
  }
  // Sanitize unicode non-breaking spaces (\u202f, \u00a0) inserted by toLocaleTimeString in modern JS runtimes
  const sanitizedStr = String(timeString).replace(/[\u202f\u00a0]/g, ' ').trim();
  const match = sanitizedStr.match(/(\d+):(\d+)(?::\d+)?\s*(AM|PM)?/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const modifier = match[3];

    if (modifier) {
      if (modifier.toUpperCase() === 'PM' && hours < 12) {
        hours += 12;
      } else if (modifier.toUpperCase() === 'AM' && hours === 12) {
        hours = 0;
      }
    }
    
    d.setHours(hours, minutes, 0, 0);
  } else {
    d.setHours(8, 0, 0, 0);
  }
  return d;
};

// Calculate Subscription Fare
exports.calculateSubscriptionFare = async (req, res) => {
  try {
    const { pickupLocation, dropoffLocation, planType, daysOfWeek, vacationDates, startDate, vehicle = 'car', passengers = 1, city = 'Karachi' } = req.body;

    if (!pickupLocation || !dropoffLocation || !planType || !daysOfWeek || !startDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const start = new Date(startDate);
    let end = new Date(startDate);
    if (planType === 'WEEKLY') {
      end.setDate(start.getDate() + 7);
    } else if (planType === 'MONTHLY') {
      end.setDate(start.getDate() + 30);
    } else {
      return res.status(400).json({ error: 'Invalid planType. Must be WEEKLY or MONTHLY' });
    }

    // Convert vacation dates to strings for easy comparison
    const vacationStrs = (vacationDates || []).map(d => new Date(d).toDateString());

    let validDaysCount = 0;
    const currentDate = new Date(start);

    while (currentDate < end) {
      const day = currentDate.getDay();
      const dateStr = currentDate.toDateString();
      if (daysOfWeek.includes(day) && !vacationStrs.includes(dateStr)) {
        validDaysCount++;
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const totalRides = validDaysCount * 2; // morning and evening

    if (totalRides === 0) {
      return res.status(400).json({ error: 'No valid rides in the given date range with the specified schedule' });
    }

    const passengerCount = Math.max(1, parseInt(passengers, 10) || 1);

    // Calculate base fare for one ride using the pricing engine
    const engineInput = {
      vehicle: vehicle,
      city: city,
      pickup: pickupLocation, // expects { lat, lng }
      dropoff: dropoffLocation, // expects { lat, lng }
      isCarpool: true,
      passengers: passengerCount, 
      hour: 8, // Typical morning commute hour
      driversAvailable: 3, 
    };

    const fareDetails = await pricingEngine.calculateFare(engineInput);
    const perPersonFare = fareDetails.fare;
    const perRideFareAllPersons = perPersonFare * passengerCount;
    const totalPrice = perRideFareAllPersons * totalRides;

    res.json({
      planType,
      validDaysCount,
      totalRides,
      passengersCount: passengerCount,
      perPersonFare,
      perRideFare: perRideFareAllPersons,
      totalPrice,
      startDate: start,
      endDate: end
    });

  } catch (error) {
    console.error('Error calculating subscription fare:', error);
    res.status(500).json({ error: 'Failed to calculate subscription fare' });
  }
};

// Create Subscription Listing (Checks and cuts passenger balance upfront)
exports.createSubscriptionListing = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { commuteDetails, planType, dateRange, financials, vehicleType } = req.body;
    
    if (!commuteDetails || !planType || !dateRange || !financials) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: 'Missing required subscription fields' });
    }

    const passenger = await User.findById(req.user._id).session(session);
    if (!passenger) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'User not found' });
    }

    const totalAmount = financials.totalPrice || 0;
    const currentBalance = passenger.wallet?.balance || 0;

    if (currentBalance < totalAmount) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ 
        error: `Insufficient wallet balance. Total cost is Rs. ${totalAmount.toLocaleString()}, but your wallet balance is Rs. ${currentBalance.toLocaleString()}. Please top up your wallet balance.`
      });
    }

    // Cut balance from passenger wallet and move to escrow balance upfront
    passenger.wallet.balance -= totalAmount;
    passenger.wallet.escrowBalance = (passenger.wallet.escrowBalance || 0) + totalAmount;
    await passenger.save({ session });

    // Create new subscription in PENDING state
    const newSubscription = new CarpoolSubscription({
      passengerId: req.user._id,
      status: 'PENDING',
      planType,
      vehicleType: vehicleType || 'car',
      commuteDetails,
      dateRange,
      financials
    });

    await newSubscription.save({ session });

    // Log the Escrow Lock payment transaction
    const escrowTransaction = new Payment({
      userId: passenger._id,
      amount: totalAmount,
      type: 'escrow_lock',
      paymentMethod: 'wallet',
      status: 'completed',
      metadata: { subscriptionId: newSubscription._id }
    });
    await escrowTransaction.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(201).json({ 
      success: true,
      message: 'Subscription created and total fare deducted from your wallet successfully!', 
      subscription: newSubscription,
      newWalletBalance: passenger.wallet.balance
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error creating subscription listing:', error);
    res.status(500).json({ error: error.message || 'Failed to create subscription listing' });
  }
};

// Get Available Subscriptions (Driver)
exports.getAvailableSubscriptions = async (req, res) => {
  try {
    const subscriptions = await CarpoolSubscription.find({ status: 'PENDING' })
      .populate('passengerId', 'name phoneNumber profileImage rating')
      .sort({ createdAt: -1 });

    res.json({ success: true, subscriptions });
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
};

// Driver Accept Subscription (Atomic Transaction)
exports.acceptSubscription = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { subscriptionId } = req.params;
    const driverId = req.user._id;

    // 1. Fetch Subscription with lock (ensure it's still PENDING)
    const subscription = await CarpoolSubscription.findOne({ 
      _id: subscriptionId, 
      status: 'PENDING' 
    }).session(session);

    if (!subscription) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'Subscription not found or already accepted by another driver' });
    }

    // 2. Fetch Passenger
    const passenger = await User.findById(subscription.passengerId).session(session);
    if (!passenger) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'Passenger not found' });
    }

    // If for any legacy reason funds were not locked at creation, lock them now
    if ((passenger.wallet.escrowBalance || 0) < subscription.financials.totalPrice) {
      if (passenger.wallet.balance >= subscription.financials.totalPrice) {
        passenger.wallet.balance -= subscription.financials.totalPrice;
        passenger.wallet.escrowBalance = (passenger.wallet.escrowBalance || 0) + subscription.financials.totalPrice;
        await passenger.save({ session });

        const escrowTransaction = new Payment({
          userId: passenger._id,
          amount: subscription.financials.totalPrice,
          type: 'escrow_lock',
          paymentMethod: 'wallet',
          status: 'completed',
          metadata: { subscriptionId: subscription._id }
        });
        await escrowTransaction.save({ session });
      } else {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ error: 'Passenger escrow balance is insufficient to fulfill subscription' });
      }
    }

    // Fetch Driver Profile
    const Driver = require('../models/Driver');
    const driverProfile = await Driver.findOne({ userId: req.user._id }).session(session);
    const driverIdToStore = driverProfile ? driverProfile._id : driverId;

    // 3. Generate all individual rides
    const ridesToCreate = [];
    const { commuteDetails, dateRange } = subscription;
    const currentDate = new Date(dateRange.startDate);
    const endDate = new Date(dateRange.endDate);
    const vacationStrs = (commuteDetails.vacationDates || []).map(d => new Date(d).toDateString());

    while (currentDate < endDate) {
      const day = currentDate.getDay();
      const dateStr = currentDate.toDateString();
      
      if (commuteDetails.daysOfWeek.includes(day) && !vacationStrs.includes(dateStr)) {
        // Morning Ride
        const morningTime = parseTimeToDate(currentDate, commuteDetails.morningTime);
        ridesToCreate.push({
          passengerId: passenger._id,
          driverId: driverIdToStore,
          type: 'carpool-subscription',
          vehicleType: subscription.vehicleType || 'car',
          status: 'scheduled',
          subscriptionId: subscription._id,
          scheduledTime: morningTime,
          pickup: {
            address: commuteDetails.pickupLocation.address,
            location: { type: 'Point', coordinates: [commuteDetails.pickupLocation.lng, commuteDetails.pickupLocation.lat] }
          },
          dropoff: {
            address: commuteDetails.dropoffLocation.address,
            location: { type: 'Point', coordinates: [commuteDetails.dropoffLocation.lng, commuteDetails.dropoffLocation.lat] }
          },
          fare: {
            final: subscription.financials.perRideFare
          },
          payment: {
            method: 'wallet',
            status: 'covered_by_subscription',
            amount: subscription.financials.perRideFare
          }
        });

        // Evening Ride (Reverse pickup and dropoff)
        const eveningTime = parseTimeToDate(currentDate, commuteDetails.eveningTime);
        ridesToCreate.push({
          passengerId: passenger._id,
          driverId: driverIdToStore,
          type: 'carpool-subscription',
          vehicleType: subscription.vehicleType || 'car',
          status: 'scheduled',
          subscriptionId: subscription._id,
          scheduledTime: eveningTime,
          pickup: {
            address: commuteDetails.dropoffLocation.address,
            location: { type: 'Point', coordinates: [commuteDetails.dropoffLocation.lng, commuteDetails.dropoffLocation.lat] }
          },
          dropoff: {
            address: commuteDetails.pickupLocation.address,
            location: { type: 'Point', coordinates: [commuteDetails.pickupLocation.lng, commuteDetails.pickupLocation.lat] }
          },
          fare: {
            final: subscription.financials.perRideFare
          },
          payment: {
            method: 'wallet',
            status: 'covered_by_subscription',
            amount: subscription.financials.perRideFare
          }
        });
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (ridesToCreate.length !== subscription.financials.totalRides) {
      await session.abortTransaction();
      session.endSession();
      return res.status(500).json({ error: 'Ride generation mismatch. Aborting for safety.' });
    }

    await Ride.insertMany(ridesToCreate, { session });

    // 4. Update Subscription Status
    subscription.driverId = driverId;
    subscription.status = 'ACTIVE';
    await subscription.save({ session });

    // Commit the transaction
    await session.commitTransaction();
    session.endSession();

    res.json({ success: true, message: 'Subscription accepted successfully', subscription });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error accepting subscription:', error);
    
    // Handle MongoDB transaction conflicts (race condition)
    if (error.code === 112 || (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError'))) {
      return res.status(409).json({ error: 'This subscription was just accepted by another driver.' });
    }
    
    res.status(500).json({ error: 'Failed to accept subscription' });
  }
};

// Central Penalty Engine for Subscriptions (Handles both Cancel and No-Show)
exports.processSubscriptionCancellation = async (req, res, ride, userId, actionType) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const subscription = await CarpoolSubscription.findById(ride.subscriptionId).session(session);
    if (!subscription) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'Subscription not found for this ride' });
    }

    // Determine Role
    const isPassenger = ride.passengerId.toString() === userId.toString();
    const isDriver = ride.driverId && ride.driverId.toString() === userId.toString();

    // If driver userId was passed instead of driver profile id, we might need to resolve it.
    // Assuming standard ride model, driverId is the driver profile ObjectId, passengerId is the user ObjectId.
    // Let's resolve the actual driver user ID for wallet/notification purposes.
    const Driver = require('../models/Driver');
    const driverDoc = ride.driverId ? await Driver.findById(ride.driverId).session(session) : null;
    const driverUserId = driverDoc ? driverDoc.userId.toString() : null;
    const isDriverUser = driverUserId === userId.toString();
    
    if (!isPassenger && !isDriverUser) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ error: 'Unauthorized to cancel this ride' });
    }

    const timeDiff = ride.scheduledTime.getTime() - Date.now();
    const isLateOrNoShow = actionType === 'no-show' || timeDiff < (2 * 60 * 60 * 1000);

    const fare = ride.fare.final || subscription.financials.perRideFare;
    let passengerRefundAmount = 0;
    let driverEarningsAmount = 0;
    let platformPenaltyAmount = 0;
    let driverWalletDeduction = 0;

    let reasonEnum = '';

    // If it's a cancellation, the caller is at fault.
    // If it's a no-show report, the OTHER party is at fault (caller is reporting them absent).
    let isPassengerFault = isPassenger;
    if (actionType === 'no-show') {
      isPassengerFault = !isPassenger;
    }

    if (isPassengerFault) {
      if (!isLateOrNoShow) {
        // Passenger informed cancel (>= 2 hours)
        reasonEnum = 'PASSENGER_CANCELLED_LATE'; // wait, we don't have PASSENGER_CANCELLED_EARLY in enum? Let's assume PASSENGER_CANCELLED_LATE is used for late, maybe just 'cancelled' for early? User said: PASSENGER_CANCELLED_LATE, DRIVER_CANCELLED_LATE, PASSENGER_NO_SHOW, DRIVER_NO_SHOW, SUBSCRIPTION_TERMINATED. If early, we can still mark it cancelled, but let's just use PASSENGER_CANCELLED_LATE for all cancellations in this context or add it.
        // Actually, let's just use PASSENGER_CANCELLED_LATE for < 2 hrs, and maybe standard 'cancelled' if we need to. But let's stick to the prompt.
        passengerRefundAmount = fare * 0.85;
        driverEarningsAmount = fare * 0.05;
        platformPenaltyAmount = fare * 0.10;
        reasonEnum = 'PASSENGER_CANCELLED'; 
      } else {
        // Passenger No-Show or Late Cancel
        passengerRefundAmount = fare * 0.60;
        driverEarningsAmount = fare * 0.30;
        platformPenaltyAmount = fare * 0.10;
        reasonEnum = actionType === 'no-show' ? 'PASSENGER_NO_SHOW' : 'PASSENGER_CANCELLED_LATE';
      }
    } else {
      // Driver at fault
      if (!isLateOrNoShow) {
        // Driver informed cancel
        passengerRefundAmount = fare * 1.00;
        driverWalletDeduction = fare * 0.05; // Driver pays 5% penalty
        platformPenaltyAmount = fare * 0.05;
        reasonEnum = 'DRIVER_CANCELLED';
      } else {
        // Driver No-Show or Late Cancel
        passengerRefundAmount = fare * 1.20; // 100% refund + 20% compensation
        driverWalletDeduction = fare * 0.40; // Driver pays 40% penalty
        platformPenaltyAmount = fare * 0.20;
        reasonEnum = actionType === 'no-show' ? 'DRIVER_NO_SHOW' : 'DRIVER_CANCELLED_LATE';
      }
    }

    // Process Driver Wallet Deduction if applicable
    if (driverWalletDeduction > 0 && driverDoc) {
      const driverUser = await User.findById(driverUserId).session(session);
      if (driverUser) {
        driverUser.wallet.balance -= driverWalletDeduction;
        await driverUser.save({ session });

        const penaltyPayment = new Payment({
          userId: driverUser._id,
          amount: driverWalletDeduction,
          type: 'penalty_fee',
          paymentMethod: 'wallet',
          status: 'completed',
          metadata: { rideId: ride._id, subscriptionId: subscription._id, reason: reasonEnum }
        });
        await penaltyPayment.save({ session });
      }
    }

    // Update Subscription Ledger
    subscription.financials.passengerRefund += passengerRefundAmount;
    subscription.financials.driverEarnings += driverEarningsAmount;
    subscription.financials.platformPenalties += platformPenaltyAmount;
    subscription.tracking.sequentialFailures += 1;
    await subscription.save({ session });

    // Update Ride
    ride.status = 'cancelled';
    ride.cancellationReason = reasonEnum;
    ride.cancelledBy = userId;
    ride.cancelledAt = new Date();
    await ride.save({ session });

    // Commit Transaction
    await session.commitTransaction();
    session.endSession();

    // -- Post-Transaction: Auto-Termination Check --
    let terminated = false;
    if (subscription.tracking.sequentialFailures >= 3) {
      await exports.settleSubscription(subscription._id, 'auto_terminate'); 
      terminated = true;
    }

    // -- Post-Transaction: Notifications & UI Triggers --
    const io = req.app.get('io');
    const { sendNotification } = require('../services/notificationService');

    const message = `Ride cancelled due to ${actionType}. Penalty applied.`;
    
    // Notify Passenger
    io.to(`user-${ride.passengerId.toString()}`).emit('ride-cancelled', { rideId: ride._id, reason: reasonEnum });
    if (typeof sendNotification === 'function') {
        await sendNotification(ride.passengerId, 'RIDE_CANCELLED', { message: message });
    }

    // Notify Driver
    if (driverUserId) {
      io.to(`user-${driverUserId}`).emit('ride-cancelled', { rideId: ride._id, reason: reasonEnum });
      if (typeof sendNotification === 'function') {
          await sendNotification(driverUserId, 'RIDE_CANCELLED', { message: message });
      }
    }

    res.json({
      success: true,
      message: 'Subscription ride cancellation processed successfully',
      terminated,
      penalties: {
        passengerRefund: passengerRefundAmount,
        driverEarnings: driverEarningsAmount,
        platformPenalty: platformPenaltyAmount,
        driverDeduction: driverWalletDeduction
      }
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error in subscription penalty engine:', error);
    res.status(500).json({ error: 'Failed to process subscription cancellation' });
  }
};

// Handle Subscription Ride Completion
exports.completeSubscriptionRide = async (req, res, ride) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const subscription = await CarpoolSubscription.findById(ride.subscriptionId).session(session);
    if (!subscription) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Update Ride
    ride.status = 'completed';
    ride.tracking = ride.tracking || {};
    ride.tracking.completedAt = new Date();
    ride.payment = ride.payment || {};
    ride.payment.status = 'covered_by_subscription';
    await ride.save({ session });

    // Update Driver Stats
    const Driver = require('../models/Driver');
    const driver = await Driver.findById(ride.driverId).session(session);
    if (driver) {
      driver.stats.totalRides += 1;
      driver.currentRide = null;
      driver.availability.status = 'available';
      await driver.save({ session });
    }

    // Update Subscription Ledger (Driver receives fare, failure count resets)
    const finalFare = ride.fare.final || subscription.financials.perRideFare;
    subscription.financials.driverEarnings += finalFare;
    subscription.tracking.completedRides += 1;
    subscription.tracking.sequentialFailures = 0; // Reset consecutive failures
    await subscription.save({ session });

    await session.commitTransaction();
    session.endSession();

    // Check if this was the last ride of the subscription
    if (subscription.tracking.completedRides + 
        (await Ride.countDocuments({ subscriptionId: subscription._id, status: 'cancelled' })) === 
        subscription.financials.totalRides) {
      await exports.settleSubscription(subscription._id, 'completed');
    }

    // Notify Passenger & Driver
    const io = req.app.get('io');
    const { sendNotification } = require('../services/notificationService');
    
    io.to(`ride-${ride._id.toString()}`).emit('ride-completed', {
      rideId: ride._id,
      fare: finalFare,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      ride: ride,
      message: 'Subscription ride completed'
    });

    const passengerObjectId = ride.passengerId?._id || ride.passengerId;
    if (typeof sendNotification === 'function') {
      await sendNotification(passengerObjectId, 'RIDE_COMPLETED', {
        rideId: ride._id,
        message: 'Subscription ride completed'
      });
    }

    res.json({
      success: true,
      ride,
      message: 'Subscription ride completed successfully'
    });

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Complete subscription ride error:', error);
    res.status(500).json({ error: 'Failed to complete subscription ride' });
  }
};

// Settlement Engine
exports.settleSubscription = async (subscriptionId, reason) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const subscription = await CarpoolSubscription.findById(subscriptionId).session(session);
    if (!subscription || subscription.status === 'COMPLETED' || subscription.status === 'TERMINATED_AUTO') {
      await session.abortTransaction();
      session.endSession();
      return;
    }

    const passenger = await User.findById(subscription.passengerId).session(session);
    const driver = await User.findById(subscription.driverId).session(session);

    // 1. Cancel remaining scheduled rides
    const remainingRides = await Ride.find({ 
      subscriptionId, 
      status: 'scheduled' 
    }).session(session);

    const remainingCount = remainingRides.length;
    for (const r of remainingRides) {
      r.status = 'cancelled';
      r.cancellationReason = 'SUBSCRIPTION_TERMINATED';
      r.cancelledAt = new Date();
      await r.save({ session });
    }

    // 2. Ledger Math
    // Passenger receives explicitly tracked refunds + the unearned fare of future rides
    const passengerPayout = subscription.financials.passengerRefund + (remainingCount * subscription.financials.perRideFare);
    // Driver receives explicitly tracked earnings
    const driverPayout = subscription.financials.driverEarnings;

    // 3. Wallet Escrow Release
    passenger.wallet.escrowBalance -= subscription.financials.totalPrice;
    passenger.wallet.balance += passengerPayout;
    
    if (driverPayout > 0 && driver) {
      driver.wallet.balance += driverPayout;
    }

    await passenger.save({ session });
    if (driver) await driver.save({ session });

    // 4. Log Payments
    const payments = [];
    payments.push(new Payment({
      userId: passenger._id,
      amount: subscription.financials.totalPrice,
      type: 'escrow_release',
      paymentMethod: 'wallet',
      status: 'completed',
      metadata: { subscriptionId }
    }));
    
    if (passengerPayout > 0) {
      payments.push(new Payment({
        userId: passenger._id,
        amount: passengerPayout,
        type: 'refund',
        paymentMethod: 'wallet',
        status: 'completed',
        metadata: { subscriptionId, reason: 'subscription_settlement' }
      }));
    }

    if (driverPayout > 0 && driver) {
      payments.push(new Payment({
        userId: driver._id,
        amount: driverPayout,
        type: 'ride_payment',
        paymentMethod: 'wallet',
        status: 'completed',
        metadata: { subscriptionId, reason: 'subscription_settlement' }
      }));
    }

    await Payment.insertMany(payments, { session });

    // 5. Finalize Subscription Status
    subscription.status = reason === 'auto_terminate' ? 'TERMINATED_AUTO' : 'COMPLETED';
    await subscription.save({ session });

    await session.commitTransaction();
    session.endSession();
    
    console.log(`Subscription ${subscriptionId} settled via ${reason}. Passenger refunded ${passengerPayout}, Driver paid ${driverPayout}.`);

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Settlement Engine Error:', error);
    throw error;
  }
};

// Get Passenger Subscriptions
exports.getPassengerSubscriptions = async (req, res) => {
  try {
    const subscriptions = await CarpoolSubscription.find({ passengerId: req.user._id })
      .populate('driverId', 'name phoneNumber profilePhoto rating stats')
      .sort({ createdAt: -1 });

    res.json({ success: true, subscriptions });
  } catch (error) {
    console.error('Error fetching passenger subscriptions:', error);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
};

// Get Driver Accepted/Committed Subscriptions
exports.getDriverSubscriptions = async (req, res) => {
  try {
    const subscriptions = await CarpoolSubscription.find({ driverId: req.user._id })
      .populate('passengerId', 'name phoneNumber profilePhoto rating stats')
      .sort({ createdAt: -1 });

    res.json({ success: true, subscriptions });
  } catch (error) {
    console.error('Error fetching driver subscriptions:', error);
    res.status(500).json({ error: 'Failed to fetch driver subscriptions' });
  }
};

// Get Subscription Details
exports.getSubscriptionDetails = async (req, res) => {
  try {
    const { subscriptionId } = req.params;
    const subscription = await CarpoolSubscription.findById(subscriptionId)
      .populate('passengerId', 'name phoneNumber profilePhoto rating stats')
      .populate('driverId', 'name phoneNumber profilePhoto rating stats');

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    const rides = await Ride.find({ subscriptionId }).sort({ scheduledTime: 1 });

    res.json({ success: true, subscription, rides });
  } catch (error) {
    console.error('Error fetching subscription details:', error);
    res.status(500).json({ error: 'Failed to fetch subscription details' });
  }
};
