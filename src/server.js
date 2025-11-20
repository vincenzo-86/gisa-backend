require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const http = require('http');
const socketIo = require('socket.io');
const { testConnection } = require('./config/database');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter');

// Import routes
const authRoutes = require('./routes/authRoutes');
const workOrderRoutes = require('./routes/workOrderRoutes');
const teamRoutes = require('./routes/teamRoutes');
const vehicleRoutes = require('./routes/vehicleRoutes');
const warehouseRoutes = require('./routes/warehouseRoutes');
const emergencyRoutes = require('./routes/emergencyRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const geocallRoutes = require('./routes/geocallRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');

const app = express();
const server = http.createServer(app);

// Socket.IO per real-time updates
const io = socketIo(server, {
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || '*',
    methods: ['GET', 'POST']
  }
});

// Rendi io disponibile globalmente
app.set('io', io);

// Middleware di base
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || '*',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', { stream: logger.stream }));
}

// Rate limiting
app.use('/api', rateLimiter);

// Static files
app.use('/uploads', express.static('uploads'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

// API Routes
const apiVersion = process.env.API_VERSION || 'v1';
app.use(`/api/${apiVersion}/auth`, authRoutes);
app.use(`/api/${apiVersion}/work-orders`, workOrderRoutes);
app.use(`/api/${apiVersion}/teams`, teamRoutes);
app.use(`/api/${apiVersion}/vehicles`, vehicleRoutes);
app.use(`/api/${apiVersion}/warehouse`, warehouseRoutes);
app.use(`/api/${apiVersion}/emergencies`, emergencyRoutes);
app.use(`/api/${apiVersion}/dashboard`, dashboardRoutes);
app.use(`/api/${apiVersion}/geocall`, geocallRoutes);
app.use(`/api/${apiVersion}/analytics`, analyticsRoutes);

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'G.I.S.A. API',
    description: 'Gestione Integrata e Supervisione Avanzata',
    version: '1.0.0',
    apiVersion: apiVersion,
    documentation: `/api/${apiVersion}/docs`
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.url} not found`,
    timestamp: new Date().toISOString()
  });
});

// Error handler
app.use(errorHandler);

// Socket.IO event handlers
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Join room per dashboard
  socket.on('join:dashboard', () => {
    socket.join('dashboard');
    logger.info(`Client ${socket.id} joined dashboard room`);
  });

  // Join room per team specifico
  socket.on('join:team', (teamId) => {
    socket.join(`team:${teamId}`);
    logger.info(`Client ${socket.id} joined team room: ${teamId}`);
  });

  // Join room per emergenza
  socket.on('join:emergency', (emergencyId) => {
    socket.join(`emergency:${emergencyId}`);
    logger.info(`Client ${socket.id} joined emergency room: ${emergencyId}`);
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Inizializzazione server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed');
    }

    // Avvia scheduled tasks
    require('./services/scheduledTasks');

    // Avvia server
    server.listen(PORT, () => {
      logger.info(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   G.I.S.A. - Gestione Integrata e Supervisione Avanzata  ║
║                                                           ║
║   Server running on port ${PORT}                            ║
║   Environment: ${process.env.NODE_ENV?.padEnd(10)}                        ║
║   API Version: ${apiVersion?.padEnd(10)}                              ║
║                                                           ║
║   API Documentation: http://localhost:${PORT}/api/${apiVersion}/docs   ║
║   Health Check: http://localhost:${PORT}/health            ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
      `);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

// Gestione errori non catturati
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

startServer();

module.exports = { app, io, server };
