const express = require('express');
const router = express.Router();
const rideController = require('../controllers/rideController');
const auth = require('../middleware/auth');

// Unauthenticated routes
router.get('/shared/:token', rideController.getSharedRideDetails);
router.get('/redirect', rideController.redirectDeepLink);

// All routes below require authentication
router.use(auth);
const priced = require('../pricing/rides');
const pricedOrLegacy = (method, legacy) => async (req, res, next) => {
  try {
    const ride = await require('../models/Ride').findById(req.params.rideId);
    if (ride?.pricing) return await priced[method](req, res, next);
    return legacy(req, res, next);
  } catch (error) { next(error); }
};
router.post('/:rideId/arrive', priced.arrive);
router.get('/:rideId/offers', priced.offers);
router.post('/:rideId/offers', priced.offer);
router.post('/:rideId/select-offer', priced.select);
router.post('/:rideId/adjustments', priced.adjust);
router.put('/:rideId/adjustments/:adjustmentId', priced.approveAdjustment);
router.get('/:rideId/receipt', priced.receipt);
router.post('/:rideId/cash', require('../pricing/settlement').cash);
router.post('/:rideId/cash-refund', require('../pricing/settlement').cashRefund);

// IMPORTANT: Specific routes must come before parameter routes
// Calculate fare (specific route)
router.post('/calculate-fare', rideController.calculateFare);

// Update driver location (specific route)
router.post('/location', rideController.updateDriverLocation);

// Get ride history (specific route)
router.get('/history', rideController.getRideHistory);

// Get active rides (specific route)
router.get('/active', rideController.getActiveRides);

// Chat routes (specific routes)
router.get('/:rideId/chat', rideController.getChatMessages);
router.post('/:rideId/chat', rideController.sendChatMessage);

// SOS alert (specific route)
router.post('/:rideId/sos', rideController.triggerSOS);

// Generate share token (specific route)
router.post('/:rideId/share', rideController.generateShareToken);

// Rate driver (specific route)
router.post('/:rideId/rate-driver', rideController.rateDriver);

// Rate passenger (specific route)
router.post('/:rideId/rate-passenger', rideController.ratePassenger);

// Accept ride (driver)
router.put('/:rideId/accept', pricedOrLegacy('accept', rideController.acceptRide));

// Counter offer (driver)
router.put('/:rideId/counter-offer', pricedOrLegacy('offer', rideController.counterOffer));

// Accept counter offer (passenger)
router.put('/:rideId/accept-counter', pricedOrLegacy('select', rideController.acceptCounterOffer));

// Start ride (driver)
router.put('/:rideId/start', pricedOrLegacy('start', rideController.startRide));

// Complete ride (driver)
router.put('/:rideId/complete', pricedOrLegacy('complete', rideController.completeRide));

// Cancel ride
router.put('/:rideId/cancel', pricedOrLegacy('cancel', rideController.cancelRide));

// Report No-Show
router.post('/:rideId/no-show', pricedOrLegacy('cancel', rideController.reportNoShow));

// Create ride (should come last or use different method)
router.post('/', priced.book);

// Get ride details (should be last because it catches all :rideId)
router.get('/:rideId', rideController.getRideDetails);

module.exports = router;