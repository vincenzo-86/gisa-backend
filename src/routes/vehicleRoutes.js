const express = require('express');
const router = express.Router();
const { sequelize } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const gpsTrackingService = require('../services/gpsTrackingService');

router.use(authenticate);

// GET /api/v1/vehicles - Lista veicoli
router.get('/', async (req, res, next) => {
  try {
    const vehicles = await sequelize.query(
      `SELECT v.*, ST_X(v.current_location::geometry) as longitude,
              ST_Y(v.current_location::geometry) as latitude,
              t.code as team_code, t.name as team_name
       FROM vehicles v
       LEFT JOIN teams t ON v.assigned_team_id = t.id
       WHERE v.is_active = true
       ORDER BY v.code`,
      { type: sequelize.QueryTypes.SELECT }
    );
    res.json({ success: true, data: vehicles });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/vehicles/:id/gps - Aggiorna posizione GPS
router.post('/:id/gps', async (req, res, next) => {
  try {
    const { latitude, longitude, speed, heading, altitude } = req.body;
    await gpsTrackingService.updateVehicleLocation(
      req.params.id,
      { latitude, longitude },
      speed,
      heading,
      altitude
    );
    res.json({ success: true, message: 'Posizione aggiornata' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
