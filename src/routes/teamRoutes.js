const express = require('express');
const router = express.Router();
const { sequelize } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);

// GET /api/v1/teams - Lista squadre
router.get('/', async (req, res, next) => {
  try {
    const teams = await sequelize.query(
      `SELECT
        t.*,
        ST_X(t.current_location::geometry) as longitude,
        ST_Y(t.current_location::geometry) as latitude,
        COUNT(DISTINCT tm.id) as members_count
      FROM teams t
      LEFT JOIN team_members tm ON t.id = tm.team_id AND tm.left_at IS NULL
      WHERE t.is_active = true
      GROUP BY t.id
      ORDER BY t.code`,
      { type: sequelize.QueryTypes.SELECT }
    );

    res.json({ success: true, data: teams });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/teams/:id - Dettaglio squadra
router.get('/:id', async (req, res, next) => {
  try {
    const [team] = await sequelize.query(
      `SELECT
        t.*,
        ST_X(t.current_location::geometry) as longitude,
        ST_Y(t.current_location::geometry) as latitude
      FROM teams t
      WHERE t.id = :id`,
      {
        replacements: { id: req.params.id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    if (!team[0]) {
      return res.status(404).json({ success: false, error: 'Squadra non trovata' });
    }

    // Membri
    const members = await sequelize.query(
      `SELECT tm.*, u.first_name, u.last_name, u.username
      FROM team_members tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = :id AND tm.left_at IS NULL`,
      {
        replacements: { id: req.params.id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    // Competenze
    const competences = await sequelize.query(
      `SELECT * FROM team_competences WHERE team_id = :id`,
      {
        replacements: { id: req.params.id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    res.json({
      success: true,
      data: {
        ...team[0],
        members,
        competences
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
