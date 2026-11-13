const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { sendOTP, verifyOTP } = require('../services/smsService');
const { generateToken } = require('../utils/helpers');

exports.register = async (req, res, next) => {
  try {
    const { phoneNumber: rawPhone, name, password, role, email, cnic } = req.body;
    const phoneNumber=require('../recovery/security').phone(rawPhone)||rawPhone;

    // Check if user exists
    const existingUser = await User.findOne({ phoneNumber: { $in: require('../recovery/security').phoneVariants(phoneNumber) } });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this phone number' });
    }

    // Create user
    const user = new User({
      phoneNumber,
      name,
      password,
      email,
      cnic,
      role: role || 'passenger'
    });

    await user.save();

    // Generate token
    const token = generateToken(user._id, user.tokenVersion || 0);

    console.log(`User registered successfully: ${phoneNumber}, role: ${user.role}`);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { phoneNumber, email, password } = req.body;
    
    const query = {};
    if (email) {
      query.email = email;
    } else if (phoneNumber) {
      const normalized=require('../recovery/security').phone(phoneNumber);
      query.phoneNumber=normalized?{$in:[normalized,'0'+normalized.slice(3),normalized.slice(1),'0092'+normalized.slice(3)]}:phoneNumber;
    } else {
      return res.status(400).json({ error: 'Phone number or email is required' });
    }

    // Find user
    const user = await User.findOne(query);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (req.body.role === 'admin' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    // Generate token
    const token = generateToken(user._id, user.tokenVersion || 0);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        profilePhoto: user.profilePhoto
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.sendOTP = async (req, res) => {
  try {
    const phoneNumber=require('../recovery/security').phone(req.body.phoneNumber)||req.body.phoneNumber;

    // Generate OTP
    const otp = String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
    
    // Store OTP in cache or database
    // For demo, we'll just send it
    
    // Send OTP via SMS
    const account=await User.findOne({phoneNumber:{$in:require('../recovery/security').phoneVariants(phoneNumber)}});
    await sendOTP(phoneNumber, otp, account?.tokenVersion || 0);

    // Store OTP for verification (in production, use Redis with TTL)
    // For demo, we'll return the OTP
    res.json({
      success: true,

      message: 'OTP sent successfully'
    });
  } catch (error) {
    console.warn('OTP delivery failed');
    res.status(500).json({ error: 'Failed to send OTP' });
  }
};

exports.verifyOTP = async (req, res) => {
  try {
    const { otp } = req.body;
    const phoneNumber=require('../recovery/security').phone(req.body.phoneNumber)||req.body.phoneNumber;
    const account=await User.findOne({phoneNumber:{$in:require('../recovery/security').phoneVariants(phoneNumber)}});

    // Verify OTP
    const isValid = await verifyOTP(phoneNumber, otp, account?.tokenVersion || 0);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // Find or create user
    let user = await User.findOne({ phoneNumber });
    if (!user) {
      return res.status(404).json({ error: 'Please register before verifying your phone number' });
    } else {
      if(!user.isActive)return res.status(403).json({error:'Account is deactivated'});
      user.isVerified = true;
      await user.save();
    }

    // Generate token
    const token = generateToken(user._id, user.tokenVersion || 0);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified
      }
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: error.message });
  }
};

exports.refreshToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.isActive || (decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const newToken = generateToken(user._id, user.tokenVersion || 0);
    res.json({ success: true, token: newToken });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

exports.logout = async (req, res) => {
  // In production, add token to blacklist
  res.json({ success: true, message: 'Logged out successfully' });
};

