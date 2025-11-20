const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    define: {
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at'
    },
    dialectOptions: {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
      useUTC: true,
      timezone: '+01:00' // Europe/Rome
    },
    timezone: '+01:00'
  }
);

// Test connessione
const testConnection = async () => {
  try {
    await sequelize.authenticate();
    console.log('✓ MySQL database connection established successfully.');

    // Verifica supporto spaziale
    const [results] = await sequelize.query("SHOW VARIABLES LIKE 'version'");
    console.log(`✓ MySQL version: ${results[0].Value}`);

    return true;
  } catch (error) {
    console.error('✗ Unable to connect to MySQL database:', error.message);
    return false;
  }
};

module.exports = {
  sequelize,
  testConnection
};
