const { sequelize } = require('../config/database');
const { AppError } = require('../middleware/errorHandler');
const workOrderService = require('../services/workOrderService');
const geocallService = require('../services/geocallService');
const logger = require('../utils/logger');

/**
 * Ottieni tutti gli ODL con filtri
 */
exports.getAllWorkOrders = async (req, res, next) => {
  try {
    const {
      status,
      priority,
      teamId,
      from_date,
      to_date,
      limit = 100,
      offset = 0
    } = req.query;

    let whereClause = [];
    let replacements = { limit: parseInt(limit), offset: parseInt(offset) };

    if (status) {
      whereClause.push('wo.status = :status');
      replacements.status = status;
    }

    if (priority) {
      whereClause.push('wo.priority = :priority');
      replacements.priority = priority;
    }

    if (teamId) {
      whereClause.push('wo.assigned_team_id = :teamId');
      replacements.teamId = teamId;
    }

    if (from_date) {
      whereClause.push('wo.received_at >= :fromDate');
      replacements.fromDate = from_date;
    }

    if (to_date) {
      whereClause.push('wo.received_at <= :toDate');
      replacements.toDate = to_date;
    }

    const whereSQL = whereClause.length > 0
      ? 'WHERE ' + whereClause.join(' AND ')
      : '';

    const workOrders = await sequelize.query(
      `SELECT * FROM active_work_orders_view ${whereSQL}
       ORDER BY
         CASE priority
           WHEN 'ALTA' THEN 1
           WHEN 'MEDIA' THEN 2
           WHEN 'BASSA' THEN 3
         END,
         received_at DESC
       LIMIT :limit OFFSET :offset`,
      {
        replacements,
        type: sequelize.QueryTypes.SELECT
      }
    );

    res.json({
      success: true,
      count: workOrders.length,
      data: workOrders
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Ottieni ODL per ID
 */
exports.getWorkOrderById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [workOrder] = await sequelize.query(
      `SELECT * FROM active_work_orders_view WHERE id = :id`,
      {
        replacements: { id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    if (!workOrder[0]) {
      return next(new AppError('ODL non trovato', 404));
    }

    // Ottieni storico stati
    const statusHistory = await sequelize.query(
      `SELECT
        wosh.*,
        u.username as changed_by_username
      FROM work_order_status_history wosh
      LEFT JOIN users u ON wosh.changed_by = u.id
      WHERE wosh.work_order_id = :id
      ORDER BY wosh.created_at DESC`,
      {
        replacements: { id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    // Ottieni foto
    const photos = await sequelize.query(
      `SELECT * FROM work_order_photos
       WHERE work_order_id = :id
       ORDER BY taken_at`,
      {
        replacements: { id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    // Ottieni materiali
    const materials = await sequelize.query(
      `SELECT * FROM work_order_materials
       WHERE work_order_id = :id`,
      {
        replacements: { id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    // Ottieni report
    const [report] = await sequelize.query(
      `SELECT * FROM work_order_reports
       WHERE work_order_id = :id`,
      {
        replacements: { id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    res.json({
      success: true,
      data: {
        ...workOrder[0],
        status_history: statusHistory,
        photos,
        materials,
        report: report[0] || null
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Calcola assegnazione ottimale
 */
exports.calculateAssignment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const assignments = await workOrderService.calculateOptimalAssignment(id);

    res.json({
      success: true,
      data: assignments
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Assegna ODL a squadra
 */
exports.assignWorkOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { team_id, mode = 'semi-automatica' } = req.body;

    if (!team_id) {
      return next(new AppError('team_id richiesto', 400));
    }

    const result = await workOrderService.assignWorkOrder(
      id,
      team_id,
      req.user.id,
      mode
    );

    // Notifica real-time
    const io = req.app.get('io');
    io.to('dashboard').emit('work_order_assigned', {
      work_order_id: id,
      team_id: team_id
    });
    io.to(`team:${team_id}`).emit('new_assignment', {
      work_order_id: id
    });

    // Sincronizza con GEOCALL
    try {
      await geocallService.sendStatusUpdate(id);
    } catch (error) {
      logger.error('Error syncing with GEOCALL:', error);
    }

    res.json({
      success: true,
      message: 'ODL assegnato con successo',
      data: result
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Aggiorna stato ODL
 */
exports.updateStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!status) {
      return next(new AppError('status richiesto', 400));
    }

    await workOrderService.updateStatus(id, status, req.user.id, notes);

    // Notifica real-time
    const io = req.app.get('io');
    io.to('dashboard').emit('work_order_updated', {
      work_order_id: id,
      status
    });

    // Sincronizza con GEOCALL
    try {
      await geocallService.sendStatusUpdate(id);
    } catch (error) {
      logger.error('Error syncing with GEOCALL:', error);
    }

    res.json({
      success: true,
      message: 'Stato aggiornato con successo'
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Carica foto ODL
 */
exports.uploadPhoto = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, description, latitude, longitude } = req.body;

    if (!req.file) {
      return next(new AppError('File non caricato', 400));
    }

    // Inserisci foto
    await sequelize.query(
      `INSERT INTO work_order_photos
       (work_order_id, type, file_path, location, taken_at, taken_by, description)
       VALUES (
         :workOrderId,
         :type,
         :filePath,
         ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326),
         CURRENT_TIMESTAMP,
         :takenBy,
         :description
       )`,
      {
        replacements: {
          workOrderId: id,
          type,
          filePath: req.file.filename,
          longitude,
          latitude,
          takenBy: req.user.id,
          description
        }
      }
    );

    res.json({
      success: true,
      message: 'Foto caricata con successo',
      data: {
        filename: req.file.filename,
        path: `/uploads/photos/${req.file.filename}`
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Completa ODL con rapportino
 */
exports.completeWorkOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      work_description,
      total_work_hours,
      total_operators,
      materials,
      anomalies,
      follow_up_needed,
      follow_up_description,
      signature_data
    } = req.body;

    // Aggiorna ODL
    await sequelize.query(
      `UPDATE work_orders
       SET total_work_hours = :totalWorkHours,
           total_operators = :totalOperators,
           status = 'completato',
           work_completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = :workOrderId`,
      {
        replacements: {
          workOrderId: id,
          totalWorkHours: total_work_hours,
          totalOperators: total_operators
        }
      }
    );

    // Crea rapportino
    await sequelize.query(
      `INSERT INTO work_order_reports
       (work_order_id, work_description, anomalies, follow_up_needed,
        follow_up_description, signature_data, signed_by, signed_at)
       VALUES (:workOrderId, :workDescription, :anomalies, :followUpNeeded,
               :followUpDescription, :signatureData, :signedBy, CURRENT_TIMESTAMP)`,
      {
        replacements: {
          workOrderId: id,
          workDescription: work_description,
          anomalies,
          followUpNeeded: follow_up_needed,
          followUpDescription: follow_up_description,
          signatureData: signature_data,
          signedBy: req.user.id
        }
      }
    );

    // Inserisci materiali
    if (materials && materials.length > 0) {
      for (const material of materials) {
        await sequelize.query(
          `INSERT INTO work_order_materials
           (work_order_id, material_code, material_name, quantity, unit, unit_price, total_price)
           VALUES (:workOrderId, :code, :name, :quantity, :unit, :unitPrice, :totalPrice)`,
          {
            replacements: {
              workOrderId: id,
              code: material.code,
              name: material.name,
              quantity: material.quantity,
              unit: material.unit,
              unitPrice: material.unit_price,
              totalPrice: material.quantity * material.unit_price
            }
          }
        );
      }
    }

    // Notifica real-time
    const io = req.app.get('io');
    io.to('dashboard').emit('work_order_completed', {
      work_order_id: id
    });

    // Sincronizza rapporto completo con GEOCALL
    try {
      await geocallService.sendCompletedReport(id);
    } catch (error) {
      logger.error('Error sending report to GEOCALL:', error);
    }

    res.json({
      success: true,
      message: 'ODL completato con successo'
    });

  } catch (error) {
    next(error);
  }
};

module.exports = exports;
