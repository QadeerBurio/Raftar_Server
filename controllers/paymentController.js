const Payment = require('../models/Payment');
const User = require('../models/User');
const Ride = require('../models/Ride');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const { processEasypaisa, processJazzCash, processRaast } = require('../services/paymentService');

/**
 * Create payment intent
 */
exports.createPaymentIntent = async (req, res) => {
  try {
    const { currency, paymentMethod, rideId } = req.body;
    if(!require('mongoose').isValidObjectId(rideId))return res.status(400).json({error:'A valid completed ride is required'});
    const ride=await Ride.findOne({_id:rideId,passengerId:req.user.id,status:'completed'});
    if(!ride || ride.pricing)return res.status(501).json({error:'Use versioned ride settlement; external confirmation is not implemented'});
    const amount=ride.fare?.final;
    const userId = req.user.id;

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    if (!['stripe', 'easypaisa', 'jazzcash', 'raast'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Unsupported payment method' });
    }
    if (paymentMethod === 'stripe' && !stripe) {
      return res.status(503).json({ error: 'Stripe is not configured' });
    }
    // Create payment record
    const payment = new Payment({
      userId,
      rideId,
      type: 'ride',
      amount,
      currency: currency || 'PKR',
      paymentMethod,
      status: 'pending'
    });
    await payment.save();

    // Process based on payment method
    let result;
    switch (paymentMethod) {
      case 'stripe':
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // Convert to cents
          currency: (currency || 'PKR').toLowerCase(),
          payment_method_types: ['card'],
          metadata: {
            paymentId: payment._id.toString(),
            userId: userId.toString()
          }
        });
        result = {
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id
        };
        break;
      
      case 'easypaisa':
        result = await processEasypaisa(amount, userId, payment._id);
        break;
      
      case 'jazzcash':
        result = await processJazzCash(amount, userId, payment._id);
        break;
      
      case 'raast':
        result = await processRaast(amount, userId, payment._id);
        break;
      
      default:
        return res.status(400).json({ error: 'Unsupported payment method' });
    }

    payment.providerReference = result.paymentIntentId || result.referenceId || result.reference;
    await payment.save();

    res.json({
      success: true,
      paymentId: payment._id,
      clientSecret: result.clientSecret,
      message: 'Payment intent created'
    });
  } catch (error) {
    console.error('Create payment intent error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Confirm payment
 */
exports.confirmPayment = async (req, res) => {
  try {
    const { paymentId, transactionId } = req.body;
    const userId = req.user.id;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.userId.toString() !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Financial settlement must be verified by a provider integration.
    // Client-supplied transaction IDs are not proof of payment.
    return res.status(501).json({ error: 'Automatic confirmation is unavailable. Use the bank-transfer credit request and admin approval flow.' });

  } catch (error) {
    console.error('Confirm payment error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get payment methods
 */
exports.getPaymentMethods = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // In production, fetch saved payment methods from your payment provider
    // For now, return default methods
    const methods = [
      {
        id: 'cash',
        type: 'cash',
        name: 'Cash',
        icon: 'money',
        isDefault: true
      },
      {
        id: 'easypaisa',
        type: 'easypaisa',
        name: 'Easypaisa',
        icon: 'phone-android',
        isDefault: false
      },
      {
        id: 'jazzcash',
        type: 'jazzcash',
        name: 'JazzCash',
        icon: 'phone-android',
        isDefault: false
      },
      {
        id: 'raast',
        type: 'raast',
        name: 'Raast',
        icon: 'account-balance',
        isDefault: false
      },
      {
        id: 'wallet',
        type: 'wallet',
        name: 'Wallet',
        icon: 'account-balance-wallet',
        isDefault: false
      }
    ];

    // Check if user has saved cards with Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      const user = await User.findById(userId);
      if (user && user.stripeCustomerId) {
        const paymentMethods = await stripe.paymentMethods.list({
          customer: user.stripeCustomerId,
          type: 'card',
        });
        const savedCards = paymentMethods.data.map(method => ({
          id: method.id,
          type: 'card',
          name: `${method.card.brand} ****${method.card.last4}`,
          last4: method.card.last4,
          brand: method.card.brand,
          expiry: `${method.card.exp_month}/${method.card.exp_year}`,
          isDefault: method.id === user.defaultPaymentMethodId
        }));
        methods.push(...savedCards);
      }
    }

    res.json({
      success: true,
      methods
    });
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Add payment method
 */
exports.addPaymentMethod = async (req, res) => {
  try {
    const { paymentMethodId, setDefault } = req.body;
    const userId = req.user.id;

    if (!paymentMethodId) {
      return res.status(400).json({ error: 'Payment method ID is required' });
    }

    // If using Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      const user = await User.findById(userId);
      
      // Create Stripe customer if not exists
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name,
          metadata: { userId: user._id.toString() }
        });
        customerId = customer.id;
        user.stripeCustomerId = customerId;
        await user.save();
      }

      // Attach payment method to customer
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });

      if (setDefault) {
        await stripe.customers.update(customerId, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        });
        user.defaultPaymentMethodId = paymentMethodId;
        await user.save();
      }
    }

    res.json({
      success: true,
      message: 'Payment method added successfully'
    });
  } catch (error) {
    console.error('Add payment method error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Remove payment method
 */
exports.removePaymentMethod = async (req, res) => {
  try {
    const { methodId } = req.params;
    const userId = req.user.id;

    if (!methodId) {
      return res.status(400).json({ error: 'Method ID is required' });
    }

    // If using Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      await stripe.paymentMethods.detach(methodId);
      
      const user = await User.findById(userId);
      if (user && user.defaultPaymentMethodId === methodId) {
        user.defaultPaymentMethodId = null;
        await user.save();
      }
    }

    res.json({
      success: true,
      message: 'Payment method removed successfully'
    });
  } catch (error) {
    console.error('Remove payment method error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get transaction history
 */
exports.getTransactionHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20, type, status } = req.query;

    const query = { userId };
    if (type) query.type = type;
    if (status) query.status = status;

    const transactions = await Payment.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('rideId', 'pickup dropoff status')
      .populate('bookingId', 'pickup dropoff status');

    const total = await Payment.countDocuments(query);

    res.json({
      success: true,
      transactions,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Get transaction details
 */
exports.getTransactionDetails = async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user.id;

    const transaction = await Payment.findById(transactionId)
      .populate('userId', 'name phoneNumber email')
      .populate('rideId', 'pickup dropoff status fare')
      .populate('bookingId', 'pickup dropoff status');

    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (transaction.userId._id.toString() !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json({
      success: true,
      transaction
    });
  } catch (error) {
    console.error('Get transaction details error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Refund payment
 */
exports.refundPayment = async (req, res) => {
  try {
    const { paymentId, reason } = req.body;
    const userId = req.user.id;

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.userId.toString() !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (payment.status !== 'completed') {
      return res.status(400).json({ error: 'Payment cannot be refunded' });
    }

    // Process refund based on payment method
    let refundResult;
    switch (payment.paymentMethod) {
      case 'stripe':
        if (payment.transactionId) {
          const refund = await stripe.refunds.create({
            payment_intent: payment.transactionId,
            amount: Math.round(payment.amount * 100),
          });
          refundResult = { success: true, refundId: refund.id };
        }
        break;
      case 'easypaisa':
        // Implement Easypaisa refund
        return res.status(501).json({ error: 'Refunds for this payment method require manual processing' });
        break;
      case 'jazzcash':
        // Implement JazzCash refund
        return res.status(501).json({ error: 'Refunds for this payment method require manual processing' });
        break;
      default:
        return res.status(501).json({ error: 'Refunds for this payment method require manual processing' });
    }

    if (refundResult?.success) {
      payment.status = 'refunded';
      payment.refundedAt = new Date();
      payment.metadata = payment.metadata || {};
      payment.metadata.set('refundReason', reason || 'Customer requested refund');
      payment.metadata.set('refundId', refundResult.refundId);
      await payment.save();

      // Update user wallet
      const user = await User.findById(userId);
      if (user.wallet) {
        user.wallet.balance -= payment.amount;
        await user.save();
      }

      return res.json({
        success: true,
        payment,
        message: 'Payment refunded successfully'
      });
    }

    res.status(500).json({ error: 'Refund failed' });
  } catch (error) {
    console.error('Refund payment error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Add to wallet
 */
exports.addToWallet = async (req, res) => {
  return res.status(501).json({ error: 'Direct wallet funding is unavailable. Submit a bank-transfer credit request at /api/payments/credit-request for admin approval.' });
};

/**
 * Withdraw from wallet
 */
exports.withdrawFromWallet = async (req, res) => {
  try {
    const { amount, bankAccount, bankName, accountHolder } = req.body;
    const userId = req.user.id;

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const session = await Payment.startSession();
    let withdrawal;
    try {
      await session.withTransaction(async () => {
        const user = await User.findOneAndUpdate(
          { _id: userId, 'wallet.balancePaisa': { $gte: require('../pricing/math').money(amount) } },
          { $inc: { 'wallet.balance': -Number(amount), 'wallet.balancePaisa': -require('../pricing/math').money(amount) } }, { new: true, session }
        );
        if (!user) { const error = new Error('Insufficient balance'); error.statusCode = 400; throw error; }
        [withdrawal] = await Payment.create([{
          userId, amount: Number(amount), type: 'wallet_withdraw', paymentMethod: 'bank_transfer', status: 'pending',
          metadata: { bankAccount: bankAccount || '', bankName: bankName || '', accountHolder: accountHolder || '' }
        }], { session });
      });
    } finally { await session.endSession(); }

    res.json({
      success: true,
      withdrawal,
      message: 'Withdrawal request submitted successfully'
    });
  } catch (error) {
    console.error('Withdraw from wallet error:', error);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
};

/**
 * Get wallet balance
 */
exports.getWalletBalance = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    
    res.json({
      success: true,
      balance: user.wallet?.balance || 0,
      currency: user.wallet?.currency || 'PKR'
    });
  } catch (error) {
    console.error('Get wallet balance error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Raast payment
 */
exports.raastPayment = async (req, res) => {
  try {
    const { amount, accountId } = req.body;
    const userId = req.user.id;

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const result = await processRaast(amount, accountId, userId);
    if (!result.success) return res.status(402).json({ error: 'Payment provider rejected the payment' });
    
    // Create payment record
    const payment = new Payment({
      userId,
      amount,
      type: 'ride',
      paymentMethod: 'raast',
      status: 'completed',
      transactionId: result.transactionId,
      completedAt: new Date()
    });
    await payment.save();

    res.json({
      success: true,
      payment,
      transactionId: result.transactionId,
      message: 'Raast payment processed successfully'
    });
  } catch (error) {
    console.error('Raast payment error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Easypaisa payment
 */
exports.easypaisaPayment = async (req, res) => {
  try {
    const { amount, phoneNumber } = req.body;
    const userId = req.user.id;

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const result = await processEasypaisa(amount, phoneNumber, userId);
    if (!result.success) return res.status(402).json({ error: 'Payment provider rejected the payment' });
    
    // Create payment record
    const payment = new Payment({
      userId,
      amount,
      type: 'ride',
      paymentMethod: 'easypaisa',
      status: 'completed',
      transactionId: result.transactionId,
      completedAt: new Date()
    });
    await payment.save();

    res.json({
      success: true,
      payment,
      transactionId: result.transactionId,
      message: 'Easypaisa payment processed successfully'
    });
  } catch (error) {
    console.error('Easypaisa payment error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * JazzCash payment
 */
exports.jazzcashPayment = async (req, res) => {
  try {
    const { amount, phoneNumber } = req.body;
    const userId = req.user.id;

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const result = await processJazzCash(amount, phoneNumber, userId);
    if (!result.success) return res.status(402).json({ error: 'Payment provider rejected the payment' });
    
    // Create payment record
    const payment = new Payment({
      userId,
      amount,
      type: 'ride',
      paymentMethod: 'jazzcash',
      status: 'completed',
      transactionId: result.transactionId,
      completedAt: new Date()
    });
    await payment.save();

    res.json({
      success: true,
      payment,
      transactionId: result.transactionId,
      message: 'JazzCash payment processed successfully'
    });
  } catch (error) {
    console.error('JazzCash payment error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Create subscription
 */
exports.createSubscription = async (req, res) => {
  try {
    const { planId, paymentMethodId } = req.body;
    const userId = req.user.id;

    if (!planId) {
      return res.status(400).json({ error: 'Plan ID is required' });
    }

    // Define subscription plans
    const plans = {
      'monthly_pass_basic': {
        name: 'Monthly Pass Basic',
        price: 2000,
        interval: 'month'
      },
      'monthly_pass_premium': {
        name: 'Monthly Pass Premium',
        price: 5000,
        interval: 'month'
      },
      'yearly_pass': {
        name: 'Yearly Pass',
        price: 20000,
        interval: 'year'
      }
    };

    const plan = plans[planId];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    // Create subscription
    const subscription = new Payment({
      userId,
      amount: plan.price,
      type: 'subscription',
      paymentMethod: 'stripe',
      status: 'pending',
      metadata: {
        planId: planId,
        planName: plan.name,
        interval: plan.interval,
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }
    });
    await subscription.save();

    // Process with Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      const user = await User.findById(userId);
      let customerId = user.stripeCustomerId;
      
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name
        });
        customerId = customer.id;
        user.stripeCustomerId = customerId;
        await user.save();
      }

      // Create subscription in Stripe
      const stripeSubscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [
          {
            price_data: {
              currency: 'pkr',
              product_data: {
                name: plan.name,
              },
              unit_amount: plan.price * 100,
              recurring: {
                interval: plan.interval,
              },
            },
          },
        ],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
      });

      subscription.metadata.set('stripeSubscriptionId', stripeSubscription.id);
      await subscription.save();

      return res.json({
        success: true,
        subscription,
        clientSecret: stripeSubscription.latest_invoice.payment_intent.client_secret,
        subscriptionId: stripeSubscription.id,
        message: 'Subscription created successfully'
      });
    }

    // Fallback without Stripe
    subscription.status = 'completed';
    subscription.completedAt = new Date();
    await subscription.save();

    res.json({
      success: true,
      subscription,
      message: 'Subscription created successfully'
    });
  } catch (error) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: error.message });
  }
};

/**
 * Process payment (helper function)
 */
const processPayment = async (amount, paymentMethod, userId) => {
  try {
    // In production, this would process the payment with the selected method
    // For now, return a mock transaction
    return {
      success: true,
      transactionId: 'txn_' + Date.now(),
      referenceId: 'ref_' + Date.now()
    };
  } catch (error) {
    console.error('Process payment error:', error);
    throw error;
  }
};

/**
 * Get wallet balance (helper function)
 */
const getWalletBalance = async (userId) => {
  try {
    const user = await User.findById(userId);
    return user.wallet?.balance || 0;
  } catch (error) {
    console.error('Get wallet balance error:', error);
    return 0;
  }
};

/**
 * Submit credit request (manual bank transfer)
 */
exports.submitCreditRequest = async (req, res) => {
  try {
    const { amount, senderName, transactionId } = req.body;
    const userId = req.user.id;
    const amountPaisa = require('../pricing/math').money(amount);

    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    
    if (!transactionId || !senderName) {
      return res.status(400).json({ error: 'Sender name and transaction ID are required' });
    }

    let screenshotUrl = null;
    if (req.file) {
      screenshotUrl = `/uploads/${req.file.filename}`;
    }

    const creditRequest = new Payment({
      userId,
      amount,
      amountPaisa,
      type: 'wallet_add',
      paymentMethod: 'bank_transfer',
      status: 'pending',
      transactionId,
      metadata: {
        senderName,
        screenshotUrl
      }
    });

    await creditRequest.save();

    res.json({
      success: true,
      payment: creditRequest,
      message: 'Credit request submitted successfully. Awaiting admin approval.'
    });
  } catch (error) {
    console.error('Submit credit request error:', error);
    res.status(500).json({ error: error.message });
  }
};