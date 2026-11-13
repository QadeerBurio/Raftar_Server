const twilio = require('twilio');

let client;
const getClient = () => {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, {logLevel:'error',timeout:8000});
  }
  return client;
};

// In production, use Redis to store OTPs with TTL
const otpStore = new Map();

exports.sendOTP = async (phoneNumber, otp, tokenVersion = 0) => {
  try {
    // Store OTP with expiry
    otpStore.set(phoneNumber, {
      tokenVersion,
      hash: require('../recovery/security').hash('login-otp',phoneNumber+':'+otp), attempts: 0,
      expires: Date.now() + 5 * 60 * 1000 // 5 minutes
    });

    // Send SMS
    await getClient().messages.create({
      body: `Your Raftar verification code is: ${otp}`,
      to: phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER
    });

    return true;
  } catch (error) {
    console.warn('OTP delivery failed');
    // Do not log OTPs or provider request payloads.

    throw error;
  }
};

exports.verifyOTP = async (phoneNumber, otp, tokenVersion = 0) => {
  try {
    const stored = otpStore.get(phoneNumber);
    
    if (!stored) {
      return false;
    }

    if (stored.tokenVersion !== tokenVersion || Date.now() > stored.expires) {
      otpStore.delete(phoneNumber);
      return false;
    }

    stored.attempts++;
    if(stored.attempts>5){otpStore.delete(phoneNumber);return false;}
    if (stored.hash !== require('../recovery/security').hash('login-otp',phoneNumber+':'+otp)) {
      return false;
    }

    otpStore.delete(phoneNumber);
    return true;
  } catch (error) {
    console.error('Verify OTP error:', error);
    return false;
  }
};

exports.sendWhatsAppMessage = async (phoneNumber, message) => {
  try {
    // Twilio WhatsApp integration
    await getClient().messages.create({
      body: message,
      to: `whatsapp:${phoneNumber}`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`
    });
    return true;
  } catch (error) {
    console.error('WhatsApp error:', error);
    return false;
  }
};

exports.sendBulkSMS = async (phoneNumbers, message) => {
  try {
    const promises = phoneNumbers.map(phone => 
      getClient().messages.create({
        body: message,
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER
      })
    );
    await Promise.all(promises);
    return true;
  } catch (error) {
    console.error('Bulk SMS error:', error);
    return false;
  }
};

exports.invalidateOTP = phone => otpStore.delete(phone);
