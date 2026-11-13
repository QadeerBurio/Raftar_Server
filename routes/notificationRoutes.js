const router = require('express').Router();
const Notification = require('../models/Notification');
router.use(require('../middleware/auth'));
router.get('/', async (req, res) => {
  const notifications = await Notification.find({ userId: req.user.id }).sort({ sentAt: -1 }).limit(100).lean();
  res.json({ notifications: notifications.map(n => ({ ...n, id: String(n._id) })) });
});
router.put('/read-all', async (req, res) => {
  await Notification.updateMany({ userId: req.user.id, read: false }, { $set: { read: true, readAt: new Date() } });
  res.json({ success: true });
});
router.put('/:notificationId/read', async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.notificationId, userId: req.user.id }, { $set: { read: true, readAt: new Date() } }, { new: true });
  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  res.json({ notificationId: req.params.notificationId });
});
router.delete('/:notificationId', async (req, res) => {
  const notification = await Notification.findOneAndDelete({ _id: req.params.notificationId, userId: req.user.id });
  if (!notification) return res.status(404).json({ error: 'Notification not found' });
  res.json({ notificationId: req.params.notificationId });
});
module.exports = router;
