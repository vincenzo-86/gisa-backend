const express = require('express');
const router = express.Router();
const { sequelize } = require('../config/database');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/stock', async (req, res, next) => {
  try {
    const stock = await sequelize.query(
      `SELECT * FROM warehouse_stock_status ORDER BY warehouse_name, category_name, name`,
      { type: sequelize.QueryTypes.SELECT }
    );
    res.json({ success: true, data: stock });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const alerts = await sequelize.query(
      `SELECT wa.*, wi.code, wi.name, wl.name as warehouse_name
       FROM warehouse_alerts wa
       JOIN warehouse_items wi ON wa.item_id = wi.id
       JOIN warehouse_locations wl ON wa.warehouse_id = wl.id
       WHERE wa.is_resolved = false
       ORDER BY wa.created_at DESC`,
      { type: sequelize.QueryTypes.SELECT }
    );
    res.json({ success: true, data: alerts });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
