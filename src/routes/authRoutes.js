const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { sequelize } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');

/**
 * @route POST /api/v1/auth/login
 * @desc Login utente
 * @access Public
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return next(new AppError('Username e password richiesti', 400));
    }

    // Trova utente
    const [users] = await sequelize.query(
      `SELECT * FROM users WHERE username = :username AND is_active = true`,
      {
        replacements: { username },
        type: sequelize.QueryTypes.SELECT
      }
    );

    const user = users[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return next(new AppError('Credenziali non valide', 401));
    }

    // Aggiorna last_login
    await sequelize.query(
      `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = :userId`,
      { replacements: { userId: user.id } }
    );

    // Genera token JWT
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * @route GET /api/v1/auth/me
 * @desc Ottieni dati utente corrente
 * @access Private
 */
router.get('/me', authenticate, async (req, res) => {
  res.json({
    success: true,
    data: req.user
  });
});

/**
 * @route POST /api/v1/auth/logout
 * @desc Logout utente
 * @access Private
 */
router.post('/logout', authenticate, (req, res) => {
  // In produzione: invalidare token (blacklist su Redis)
  res.json({
    success: true,
    message: 'Logout effettuato con successo'
  });
});

module.exports = router;
