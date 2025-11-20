const express = require('express');
const router = express.Router();
const { sequelize } = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/v1/dashboard/overview - Panoramica generale
router.get('/overview', async (req, res, next) => {
  try {
    const [stats] = await sequelize.query(
      `SELECT
        COUNT(DISTINCT CASE WHEN wo.status NOT IN ('completato', 'validato') THEN wo.id END) as active_work_orders,
        COUNT(DISTINCT CASE WHEN wo.priority = 'ALTA' AND wo.status NOT IN ('completato', 'validato') THEN wo.id END) as high_priority,
        COUNT(DISTINCT CASE WHEN t.status != 'fuori_servizio' THEN t.id END) as available_teams,
        COUNT(DISTINCT CASE WHEN t.status IN ('in_viaggio', 'in_lavorazione') THEN t.id END) as busy_teams,
        COUNT(DISTINCT e.id) as active_emergencies
      FROM work_orders wo
      CROSS JOIN teams t
      CROSS JOIN emergencies e
      WHERE e.status IN ('attiva', 'in_gestione')`,
      { type: sequelize.QueryTypes.SELECT }
    );

    res.json({ success: true, data: stats[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/dashboard/realtime - Dati real-time per mappa
router.get('/realtime', async (req, res, next) => {
  try {
    const teams = await sequelize.query(
      `SELECT
        t.id, t.code, t.name, t.status,
        ST_X(t.current_location::geometry) as longitude,
        ST_Y(t.current_location::geometry) as latitude,
        v.license_plate
      FROM teams t
      LEFT JOIN vehicles v ON t.id = v.assigned_team_id
      WHERE t.is_active = true`,
      { type: sequelize.QueryTypes.SELECT }
    );

    const workOrders = await sequelize.query(
      `SELECT * FROM active_work_orders_view`,
      { type: sequelize.QueryTypes.SELECT }
    );

    res.json({
      success: true,
      data: { teams, work_orders: workOrders }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
