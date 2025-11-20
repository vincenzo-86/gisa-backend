const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const emergencyService = require('../services/emergencyService');

router.use(authenticate);

router.post('/', authorize('dispatcher', 'admin', 'direttore_tecnico'), async (req, res, next) => {
  try {
    const result = await emergencyService.activateEmergency(req.body, req.user.id);
    const io = req.app.get('io');
    io.to('dashboard').emit('emergency_activated', result);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/deactivate', authorize('dispatcher', 'admin', 'direttore_tecnico'), async (req, res, next) => {
  try {
    const report = await emergencyService.deactivateEmergency(req.params.id, req.user.id);
    const io = req.app.get('io');
    io.to('dashboard').emit('emergency_deactivated', { emergency_id: req.params.id });
    res.json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
