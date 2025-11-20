const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { authenticate, authorize } = require('../middleware/auth');
const workOrderController = require('../controllers/workOrderController');

// Configurazione upload foto
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/photos/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'photo-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10485760 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Solo immagini sono consentite'));
    }
  }
});

// Tutte le route richiedono autenticazione
router.use(authenticate);

/**
 * @route GET /api/v1/work-orders
 * @desc Ottieni lista ODL con filtri
 * @access Private
 */
router.get('/', workOrderController.getAllWorkOrders);

/**
 * @route GET /api/v1/work-orders/:id
 * @desc Ottieni dettaglio ODL
 * @access Private
 */
router.get('/:id', workOrderController.getWorkOrderById);

/**
 * @route GET /api/v1/work-orders/:id/assignment
 * @desc Calcola assegnazione ottimale
 * @access Private (Dispatcher, Admin)
 */
router.get('/:id/assignment', authorize('dispatcher', 'admin', 'direttore_tecnico'), workOrderController.calculateAssignment);

/**
 * @route POST /api/v1/work-orders/:id/assign
 * @desc Assegna ODL a squadra
 * @access Private (Dispatcher, Admin)
 */
router.post('/:id/assign', authorize('dispatcher', 'admin', 'direttore_tecnico'), workOrderController.assignWorkOrder);

/**
 * @route PUT /api/v1/work-orders/:id/status
 * @desc Aggiorna stato ODL
 * @access Private (Caposquadra, Dispatcher, Admin)
 */
router.put('/:id/status', authorize('caposquadra', 'dispatcher', 'admin', 'direttore_tecnico'), workOrderController.updateStatus);

/**
 * @route POST /api/v1/work-orders/:id/photos
 * @desc Carica foto per ODL
 * @access Private (Caposquadra)
 */
router.post('/:id/photos', authorize('caposquadra', 'operatore', 'admin'), upload.single('photo'), workOrderController.uploadPhoto);

/**
 * @route POST /api/v1/work-orders/:id/complete
 * @desc Completa ODL con rapportino
 * @access Private (Caposquadra)
 */
router.post('/:id/complete', authorize('caposquadra', 'admin'), workOrderController.completeWorkOrder);

module.exports = router;
