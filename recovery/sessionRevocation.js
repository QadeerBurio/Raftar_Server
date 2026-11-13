const User = require('../models/User');
const mongoose = require('mongoose');
exports.start = io => {
  let stream,
    retry,
    stopped = false;
  const open = () => {
    if (stopped || stream || mongoose.connection.readyState !== 1) return;
    stream = User.watch([{
      $match: {
        operationType: {
          $in: ['update', 'replace', 'delete']
        }
      }
    }]);
    stream.on('change', event => {
      if (event.operationType !== 'update' || Object.hasOwn(event.updateDescription.updatedFields, 'tokenVersion') || event.updateDescription.updatedFields.isActive === false) io.in('user-' + event.documentKey._id).disconnectSockets(true);
    });
    stream.on('error', () => {
      console.warn('Session revocation stream unavailable; retrying');
      const old = stream;
      stream = null;
      old.close().catch(() => {});
      retry = setTimeout(open, 5000);
      retry.unref?.();
    });
  };
  mongoose.connection.on('connected', open);
  open();
  return async () => {
    stopped = true;
    clearTimeout(retry);
    mongoose.connection.off('connected', open);
    if (stream) await stream.close();
  };
};
