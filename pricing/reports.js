const {
  Settlement
} = require('./models');
exports.dashboard = async monthStart => {
  const net = {
    $subtract: ['$allocations.platformRevenuePaisa', {
      $ifNull: ['$refundedAllocations.platformRevenuePaisa', 0]
    }]
  };
  const [total, byType] = await Promise.all([Settlement.aggregate([{
    $match: {
      status: 'settled'
    }
  }, {
    $group: {
      _id: null,
      totalPaisa: {
        $sum: net
      }
    }
  }]), Settlement.aggregate([{
    $match: {
      status: 'settled',
      createdAt: {
        $gte: monthStart
      }
    }
  }, {
    $lookup: {
      from: 'rides',
      localField: 'rideId',
      foreignField: '_id',
      as: 'ride'
    }
  }, {
    $unwind: '$ride'
  }, {
    $group: {
      _id: '$ride.type',
      total: {
        $sum: {
          $divide: [net, 100]
        }
      },
      count: {
        $sum: 1
      }
    }
  }])]);
  return {
    total: (total[0]?.totalPaisa || 0) / 100,
    byType,
    basis: 'Net platform fees accrued; cash fees may be outstanding receivables',
    scope: 'versioned_pricing_settlements'
  };
};
