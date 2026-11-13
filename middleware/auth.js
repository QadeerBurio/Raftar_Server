const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      throw new Error();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user || !user.isActive || (decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      throw new Error();
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    if (['MongooseServerSelectionError', 'MongoServerSelectionError', 'MongoNetworkError'].includes(error.name)) {
      return res.status(503).json({ error: 'Database unavailable. Please try again shortly.' });
    }
    res.status(401).json({ error: 'Please authenticate' });
  }
};