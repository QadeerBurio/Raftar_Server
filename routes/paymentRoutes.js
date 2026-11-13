const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const auth = require('../middleware/auth');
const { upload } = require('../middleware/upload');

// All routes require authentication
router.use(auth);
router.use(async(req,res,next)=>{
  try {
    if(req.body?.rideId && !['/process'].includes(req.path)) {
      const ride=await require('../models/Ride').findById(req.body.rideId);
      if(ride?.pricing)return res.status(501).json({error:'Versioned rides must use wallet settlement or the authenticated cash workflow'});
    }
    if(req.path==='/refund' && req.body?.paymentId){const payment=await require('../models/Payment').findById(req.body.paymentId);const ride=payment?.rideId && await require('../models/Ride').findById(payment.rideId);if(ride?.pricing)return res.status(501).json({error:'Request an admin ledger refund for this ride'});}
    next();
  }catch(e){next(e);}
});
router.post('/process', require('../controllers/settlementController').processPayment);

// IMPORTANT: Specific routes must come before parameter routes

// Payment methods (specific routes)
router.get('/methods', paymentController.getPaymentMethods);
router.post('/methods', paymentController.addPaymentMethod);

// Wallet operations (specific routes)
router.get('/wallet/balance', paymentController.getWalletBalance);
router.post('/wallet/add', paymentController.addToWallet);
router.post('/wallet/withdraw', paymentController.withdrawFromWallet);
router.post('/credit-request', upload.single('screenshot'), paymentController.submitCreditRequest);

// Payment intent
router.post('/create-intent', paymentController.createPaymentIntent);

// Confirm payment
router.post('/confirm', paymentController.confirmPayment);

// Refund payment
router.post('/refund', paymentController.refundPayment);

// Transaction history (specific route)
router.get('/transactions', paymentController.getTransactionHistory);

// Subscription
router.post('/subscription', paymentController.createSubscription);

// Payment gateways (specific routes)
router.post('/raast/pay', (req,res)=>res.status(501).json({error:'Verified external settlement is not implemented'}));
router.post('/easypaisa/pay', (req,res)=>res.status(501).json({error:'Verified external settlement is not implemented'}));
router.post('/jazzcash/pay', (req,res)=>res.status(501).json({error:'Verified external settlement is not implemented'}));

// Delete payment method (with param)
router.delete('/methods/:methodId', paymentController.removePaymentMethod);

// Transaction details (with param - should be last)
router.get('/transactions/:transactionId', paymentController.getTransactionDetails);

module.exports = router;
