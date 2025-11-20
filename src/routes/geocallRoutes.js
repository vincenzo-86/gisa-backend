const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const geocallService = require('../services/geocallService');

router.use(authenticate);

// POST /api/v1/geocall/sync - Sincronizzazione manuale
router.post('/sync', async (req, res, next) => {
  try {
    const newOrders = await geocallService.fetchNewWorkOrders();
    res.json({ success: true, imported: newOrders.length, data: newOrders });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
