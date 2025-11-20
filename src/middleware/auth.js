const jwt = require('jsonwebtoken');
const { AppError } = require('./errorHandler');
const { sequelize } = require('../config/database');

// Verifica token JWT
const authenticate = async (req, res, next) => {
  try {
    // Ottieni token dall'header
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return next(new AppError('Non autenticato. Effettua il login.', 401));
    }

    // Verifica token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Ottieni utente dal database
    const [users] = await sequelize.query(
      'SELECT id, username, email, first_name, last_name, role, is_active FROM users WHERE id = :userId',
      {
        replacements: { userId: decoded.id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    const user = users[0];

    if (!user) {
      return next(new AppError('Utente non trovato', 401));
    }

    if (!user.is_active) {
      return next(new AppError('Account disabilitato', 401));
    }

    // Aggiungi user alla request
    req.user = user;
    next();
  } catch (error) {
    return next(new AppError('Token non valido o scaduto', 401));
  }
};

// Verifica ruoli
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new AppError('Non autorizzato ad accedere a questa risorsa', 403));
    }
    next();
  };
};

// Verifica permessi specifici
const checkPermission = (permission) => {
  return async (req, res, next) => {
    try {
      const [result] = await sequelize.query(
        'SELECT COUNT(*) as count FROM user_permissions WHERE user_id = :userId AND permission = :permission',
        {
          replacements: {
            userId: req.user.id,
            permission: permission
          },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (result[0].count === 0) {
        return next(new AppError('Permessi insufficienti', 403));
      }

      next();
    } catch (error) {
      return next(error);
    }
  };
};

module.exports = {
  authenticate,
  authorize,
  checkPermission
};
