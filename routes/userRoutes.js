const router = require('express').Router();
const auth = require('../middleware/auth');
const { upload } = require('../middleware/upload');

router.use(auth);
const publicUser = user => {
  const result = user.toObject();
  delete result.password;
  result.id = String(user._id);
  return result;
};
router.get('/profile', (req, res) => res.json({ user: publicUser(req.user) }));
router.put('/profile', async (req, res) => {
  for (const field of ['name', 'email', 'gender', 'cnic', 'deviceToken']) {
    if (req.body[field] !== undefined) req.user[field] = req.body[field];
  }
  await req.user.save();
  res.json({ user: publicUser(req.user) });
});
router.put('/profile/photo', upload.single('profilePhoto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Profile photo required' });
  req.user.profilePhoto = `/uploads/${req.file.filename}`;
  await req.user.save();
  res.json({ profilePhoto: req.user.profilePhoto });
});
router.put('/settings', async (req, res) => {
  const allowed = ['notifications', 'darkMode', 'language', 'locationServices', 'soundEnabled', 'vibrationEnabled', 'emailNotifications', 'smsNotifications', 'autoAcceptRides', 'maxDistance', 'shareRideData'];
  for (const field of allowed) {
    if (req.body[field] !== undefined) req.user.settings[field] = req.body[field];
  }
  await req.user.save();
  res.json({ settings: req.user.settings });
});
router.post('/emergency-contacts', async (req, res) => {
  const { name, phoneNumber, relationship } = req.body;
  if (!name || !phoneNumber) return res.status(400).json({ error: 'Name and phone number required' });
  req.user.emergencyContacts.push({ name, phoneNumber, relationship });
  await req.user.save();
  const contact = req.user.emergencyContacts.at(-1).toObject();
  res.status(201).json({ contact: { ...contact, id: String(contact._id) } });
});
router.delete('/emergency-contacts/:contactId', async (req, res) => {
  const contact = req.user.emergencyContacts.id(req.params.contactId);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  contact.deleteOne();
  await req.user.save();
  res.json({ contactId: req.params.contactId });
});
router.post('/saved-places', async (req, res) => {
  const { name, address, location } = req.body;
  if (!name || !address) return res.status(400).json({ error: 'Name and address required' });
  req.user.savedPlaces.push({ name, address, location });
  await req.user.save();
  const place = req.user.savedPlaces.at(-1).toObject();
  res.status(201).json({ place: { ...place, id: String(place._id) } });
});
router.delete('/saved-places/:placeId', async (req, res) => {
  const place = req.user.savedPlaces.id(req.params.placeId);
  if (!place) return res.status(404).json({ error: 'Place not found' });
  place.deleteOne();
  await req.user.save();
  res.json({ placeId: req.params.placeId });
});
module.exports = router;
