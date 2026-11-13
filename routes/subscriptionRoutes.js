const express = require('express');
const router = express.Router();
const subscriptionController = require('../controllers/subscriptionController');
const protect = require('../middleware/auth'); 

// Calculate Fare (Passenger)
router.post('/calculate', protect, subscriptionController.calculateSubscriptionFare);

// Passenger Subscriptions
router.get('/passenger', protect, subscriptionController.getPassengerSubscriptions);

// Driver Accepted Subscriptions
router.get('/driver', protect, subscriptionController.getDriverSubscriptions);

// Create Listing (Passenger)
router.post('/', protect, subscriptionController.createSubscriptionListing);

// Accept Listing (Driver)
router.post('/:subscriptionId/accept', protect, subscriptionController.acceptSubscription);

// Get Available Listings (Driver)
router.get('/', protect, subscriptionController.getAvailableSubscriptions);

// Get Subscription Details
router.get('/:subscriptionId', protect, subscriptionController.getSubscriptionDetails);

module.exports = router;
