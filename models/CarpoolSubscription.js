const mongoose = require('mongoose');

const carpoolSubscriptionSchema = new mongoose.Schema({
  passengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // Driver accepts later
  status: { 
    type: String, 
    enum: ['PENDING', 'ACTIVE', 'COMPLETED', 'TERMINATED_AUTO', 'CANCELLED'],
    default: 'PENDING'
  },
  planType: { type: String, enum: ['WEEKLY', 'MONTHLY'], required: true },
  vehicleType: { type: String, enum: ['bike', 'rickshaw', 'car', 'ac_car', 'luxury_car'], default: 'car' },
  commuteDetails: {
    passengersCount: { type: Number, default: 1 },
    pickupLocation: {
      lat: Number,
      lng: Number,
      address: String
    },
    dropoffLocation: {
      lat: Number,
      lng: Number,
      address: String
    },
    morningTime: String,
    eveningTime: String,
    daysOfWeek: [Number], // 0 (Sun) to 6 (Sat)
    vacationDates: [Date]
  },
  dateRange: {
    startDate: Date,
    endDate: Date
  },
  financials: {
    perRideFare: Number,
    totalRides: Number,
    totalPrice: Number, // Amount escrowed upfront
    driverEarnings: { type: Number, default: 0 },
    passengerRefund: { type: Number, default: 0 },
    platformPenalties: { type: Number, default: 0 },
  },
  tracking: {
    sequentialFailures: { type: Number, default: 0 },
    completedRides: { type: Number, default: 0 }
  }
}, { timestamps: true });

// Indexes
carpoolSubscriptionSchema.index({ passengerId: 1, status: 1 });
carpoolSubscriptionSchema.index({ driverId: 1, status: 1 });

module.exports = mongoose.model('CarpoolSubscription', carpoolSubscriptionSchema);
