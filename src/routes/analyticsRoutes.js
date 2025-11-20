const express = require('express');
const router = express.Router();
const { sequelize } = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/v1/analytics/kpi - KPI performance
router.get('/kpi', async (req, res, next) => {
  try {
    const { from_date, to_date, team_id } = req.query;

    let whereClause = [];
    let replacements = {};

    if (from_date) {
      whereClause.push('date >= :fromDate');
      replacements.fromDate = from_date;
    }
    if (to_date) {
      whereClause.push('date <= :toDate');
      replacements.toDate = to_date;
    }
    if (team_id) {
      whereClause.push('team_id = :teamId');
      replacements.teamId = team_id;
    }

    const whereSQL = whereClause.length > 0
      ? 'WHERE ' + whereClause.join(' AND ')
      : '';

    const kpi = await sequelize.query(
      `SELECT * FROM performance_kpi ${whereSQL} ORDER BY date DESC`,
      {
        replacements,
        type: sequelize.QueryTypes.SELECT
      }
    );

    res.json({ success: true, data: kpi });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
