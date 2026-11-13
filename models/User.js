const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  tokenVersion: { type: Number, default: 0 },
  emailVerified: { type: Boolean, default: false },
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  // Add these fields if not already present
  gender: {
    type: String,
    enum: ['male', 'female', 'other'],
    default: 'male'
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  emergencyContacts: [{
    name: {
      type: String,
      required: true
    },
    phoneNumber: {
      type: String,
      required: true
    },
    relationship: {
      type: String,
      enum: ['spouse', 'parent', 'sibling', 'friend', 'other'],
      default: 'other'
    }
  }],
  deviceToken: {
    type: String,
    default: null
  },
  email: {
    type: String,
    lowercase: true
  },
  cnic: {
    type: String,
    sparse: true
  },
  profilePhoto: {
    type: String
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['passenger', 'driver', 'admin', 'fleet_owner'],
    default: 'passenger'
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  wallet: {
    balancePaisa: { type: Number, default: 0 },
    balance: {
      type: Number,
      default: 0
    },
    escrowBalance: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'PKR'
    }
  },

  savedPlaces: [{ name: String, address: String, location: { latitude: Number, longitude: Number } }],
  settings: {
    notifications: { type: Boolean, default: true },
    darkMode: { type: Boolean, default: true },
    language: { type: String, default: 'en' },
    locationServices: { type: Boolean, default: true },
    soundEnabled: { type: Boolean, default: true },
    vibrationEnabled: { type: Boolean, default: true },
    emailNotifications: { type: Boolean, default: true },
    smsNotifications: { type: Boolean, default: true },
    autoAcceptRides: { type: Boolean, default: false },
    maxDistance: { type: Number, default: 10 },
    shareRideData: { type: Boolean, default: false }
  },
  preferences: {
    language: {
      type: String,
      default: 'en'
    },
    notifications: {
      type: Boolean,
      default: true
    }
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    }
  },
  emergencyContacts: [{
    name: String,
    phoneNumber: String,
    relationship: String
  }],
  // Add Stripe fields
  stripeCustomerId: {
    type: String,
    default: null
  },
  defaultPaymentMethodId: {
    type: String,
    default: null
  },
  stats: {
    totalRides: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

userSchema.pre('save', function() {
  if(!this.isNew && this.isModified('email'))this.emailVerified=false;
  if(!this.isNew && this.isModified('phoneNumber'))this.isVerified=false;
  if (this.isNew || (this.isModified('wallet.balance') && !this.isModified('wallet.balancePaisa'))) {
    this.wallet.balancePaisa = require('../pricing/math').roundDecimalPaisa(this.wallet.balance || 0);
    this.wallet.balance = this.wallet.balancePaisa / 100;
  }
});
userSchema.pre('save', async function() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

userSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('User', userSchema);
