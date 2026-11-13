// Compatibility adapter for older estimate consumers. New bookings require owner-scoped v2 quotes.
const { cardFor, demandSurge } = require('../pricing/service');
const { calculate, point, inside, categoryVehicles } = require('../pricing/math');
const configCache = { vehicleRates: {}, cityTiers: {}, intercityRates: [], surgeConfig: [], peakHours: [], lastUpdated: null };
async function loadConfig() { configCache.lastUpdated = new Date(); }
async function calculateFare(input) {
  const category = input.category || Object.keys(categoryVehicles).find(k => categoryVehicles[k] === input.vehicle);
  const card = await cardFor(input.city, category);
  const pickup = point(input.pickup), dropoff = point(input.dropoff), stops = (input.stops || []).map(point);
  for(const p of [pickup,...stops,dropoff])require('../pricing/math').assert(inside(p.location.coordinates,card.zone.coordinates[0]),'Endpoint outside service zone',422);
  const route = await require('./mapService').verifiedRoadRoute(pickup.location,dropoff.location,stops.map(p=>p.location));
  const surge = await demandSurge(card,new Date());
  require('../pricing/math').assert(surge.available,'No eligible drivers',409);
  const snapshot=calculate(card,route.distanceMeters,route.durationSeconds,surge.multiplierBps);
  return { fare:snapshot.breakdown.passengerTotalPaisa/100,distance:route.distanceMeters/1000,time:route.durationSeconds/60,breakdown:snapshot.breakdown,pricing:snapshot };
}
module.exports={calculateFare,loadConfig,configCache};
