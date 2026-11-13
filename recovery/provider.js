// No development bypass: production and development both use real configured providers.
const nodemailer = require('nodemailer');
exports.available = destination => {
  if (!process.env.RESET_HMAC_SECRET || process.env.RESET_HMAC_SECRET.length < 32) return false;
  const sms = !!(/^AC[\da-f]{32}$/i.test(process.env.TWILIO_ACCOUNT_SID || '') && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
  const email = !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS);
  return destination ? destination.includes('@') ? email : sms : sms || email;
};
exports.send = async (destination, message) => {
  if (destination.includes('@')) {
    if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) throw Error('Provider unavailable');
    const transport = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT || 587),
      secure: process.env.EMAIL_PORT === '465',
      requireTLS: process.env.EMAIL_PORT !== '465',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      },
      logger: false,
      debug: false,
      connectionTimeout: 8000,
      socketTimeout: 8000
    });
    const result = await transport.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: destination,
      subject: 'Raftar account security',
      text: message
    });
    if (!result.accepted?.length) throw Error('Delivery rejected');
  } else {
    const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, {
      logLevel: 'error',
      timeout: 8000
    });
    const result = await client.messages.create({
      to: destination,
      from: process.env.TWILIO_PHONE_NUMBER,
      body: message
    });
    if (!result.sid || ['failed', 'undelivered', 'canceled'].includes(result.status)) throw Error('Delivery rejected');
  }
};
