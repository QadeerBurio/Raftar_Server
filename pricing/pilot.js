// No database connection is opened merely by importing pilot settings.
const {
  defaults
} = require('./config');
const rows = [['bike', 4000, 1800, 100, 8000, 200], ['rickshaw', 6000, 2500, 150, 12000, 300], ['economy', 9000, 3500, 200, 18000, 500], ['comfort', 13000, 4500, 300, 25000, 700]];
module.exports = rows.map(([category, basePaisa, perKmPaisa, perMinutePaisa, minimumPaisa, waitingPerMinutePaisa]) => ({
  city: 'karachi',
  category,
  version: 'pilot-1-draft',
  status: 'draft',
  effectiveFrom: new Date('2026-11-13T00:00:00+05:00'),
  effectiveTo: new Date('2027-11-13T00:00:00+05:00'),
  rates: {
    basePaisa,
    perKmPaisa,
    perMinutePaisa,
    minimumPaisa,
    waitingPerMinutePaisa
  },
  policy: structuredClone(defaults),
  zone: {
    type: 'Polygon',
    coordinates: [[[66.60, 24.60], [67.60, 24.60], [67.60, 25.60], [66.60, 25.60], [66.60, 24.60]]]
  }
}));
