const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const { validateRequest } = require('../middleware/validation');
const auth = require('../middleware/auth');

console.log('body is', typeof body);
console.log('validateRequest is', typeof validateRequest);
console.log('authController is', typeof authController);
console.log('authController.register is', typeof authController.register);

// Register
router.post(
  '/register',
    body('phoneNumber').isMobilePhone('any').withMessage('Valid phone number required'),
    body('name').notEmpty().withMessage('Name is required'),
    body('password').custom(require('../recovery/security').policy).withMessage('Password must be at least 6 characters and at most 72 UTF-8 bytes').hide(),
    body('role').optional().isIn(['passenger', 'driver']),
  validateRequest,
  authController.register
);

// Dedicated admin registration endpoint.
router.post(
  '/admin/register',
  body('phoneNumber').isMobilePhone('any').withMessage('Valid phone number required'),
  body('name').notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').custom(require('../recovery/security').policy).withMessage('Password must be at least 6 characters and at most 72 UTF-8 bytes').hide(),
  validateRequest,
  (req, res, next) => {
    req.body.role = 'admin';
    return authController.register(req, res, next);
  }
);

// Login
router.post(
  '/login',
  [
    body('password').notEmpty().withMessage('Password is required'),
    body().custom((value) => {
      if (!value.phoneNumber && !value.email) {
        throw new Error('Either phone number or email is required');
      }
      return true;
    })
  ],
  validateRequest,
  authController.login
);

// Send OTP
router.post(
  '/send-otp',
  [
    body('phoneNumber').isMobilePhone().withMessage('Valid phone number required'),
  ],
  validateRequest,
  authController.sendOTP
);

// Verify OTP
router.post(
  '/verify-otp',
  [
    body('phoneNumber').isMobilePhone().withMessage('Valid phone number required'),
    body('otp').isLength({ min: 4, max: 6 }).withMessage('Valid OTP required').hide(),
  ],
  validateRequest,
  authController.verifyOTP
);

// Refresh Token
router.post('/refresh-token', authController.refreshToken);

// Logout
router.post('/logout', auth, authController.logout);

// Recovery is purpose-separated from login/phone verification OTPs.
const recovery = require('../recovery/controller');
router.post('/forgot-password', recovery.forgot);
router.post('/reset-status',async(req,res)=>{await recovery.rate('status-ip:'+req.ip,100);const c=require('../recovery/security').validChallenge(req.body?.challengeId)&&await require('../recovery/models').Challenge.findById(req.body.challengeId);if(!c)return res.status(400).json({error:'Recovery challenge unavailable'});res.json({success:true,canVerify:c.state==='pending',challengeId:String(c._id),maskedDestination:require('../recovery/security').mask(c.destination),expiresAt:c.expiresAt,resendAt:c.resendAt,serverNow:new Date().toISOString()});});
router.post('/verify-reset-otp', recovery.verify);
router.post('/resend-reset-otp', recovery.resend);
router.post('/reset-password', recovery.reset);
module.exports = router;
