const axios = require('axios');
const { sequelize } = require('../config/database');
const logger = require('../utils/logger');
const workOrderService = require('./workOrderService');

class GeocallService {

  constructor() {
    this.apiUrl = process.env.GEOCALL_API_URL;
    this.apiKey = process.env.GEOCALL_API_KEY;
    this.apiSecret = process.env.GEOCALL_API_SECRET;
    this.syncInterval = parseInt(process.env.GEOCALL_SYNC_INTERVAL) || 30000;

    // Configurazione axios con auth
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        'X-API-Secret': this.apiSecret
      }
    });

    // Interceptor per logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug('GEOCALL Request:', {
          method: config.method,
          url: config.url,
          data: config.data
        });
        return config;
      },
      (error) => {
        logger.error('GEOCALL Request Error:', error);
        return Promise.reject(error);
      }
    );

    this.client.interceptors.response.use(
      (response) => {
        logger.debug('GEOCALL Response:', {
          status: response.status,
          data: response.data
        });
        return response;
      },
      (error) => {
        logger.error('GEOCALL Response Error:', {
          status: error.response?.status,
          data: error.response?.data
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Polling per nuovi ODL da GEOCALL
   */
  async fetchNewWorkOrders() {
    try {
      logger.info('Fetching new work orders from GEOCALL...');

      const response = await this.client.get('/work-orders/new');

      if (!response.data || !response.data.work_orders) {
        logger.info('No new work orders from GEOCALL');
        return [];
      }

      const newOrders = response.data.work_orders;
      logger.info(`Received ${newOrders.length} new work orders from GEOCALL`);

      // Processa ogni ODL
      const imported = [];
      for (const odl of newOrders) {
        try {
          const importedOdl = await this.importWorkOrder(odl);
          imported.push(importedOdl);

          // Log sincronizzazione
          await this.logSync(importedOdl.id, 'receive_odl', 'incoming', odl, null, 'success');

        } catch (error) {
          logger.error('Error importing work order:', error);
          await this.logSync(null, 'receive_odl', 'incoming', odl, null, 'error', error.message);
        }
      }

      return imported;

    } catch (error) {
      logger.error('Error fetching work orders from GEOCALL:', error);
      throw error;
    }
  }

  /**
   * Importa ODL da GEOCALL nel sistema G.I.S.A.
   */
  async importWorkOrder(geocallData) {
    try {
      // Verifica se esiste già
      const [existing] = await sequelize.query(
        `SELECT id FROM work_orders WHERE geocall_id = :geocallId`,
        {
          replacements: { geocallId: geocallData.id },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (existing.length > 0) {
        logger.info(`Work order ${geocallData.id} already exists`);
        return existing[0];
      }

      // Genera codice interno
      const code = await this.generateWorkOrderCode();

      // Calcola tempi limite in base alla priorità
      const responseTimes = await this.getResponseTimes();
      const responseTimeLimit = responseTimes[geocallData.priority];

      // Inserisci ODL
      const [result] = await sequelize.query(
        `INSERT INTO work_orders (
          geocall_id,
          code,
          priority,
          type,
          description,
          location,
          address,
          status,
          received_at,
          response_time_limit
        ) VALUES (
          :geocallId,
          :code,
          :priority,
          :type,
          :description,
          ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326),
          :address,
          'ricevuto',
          CURRENT_TIMESTAMP,
          :responseTimeLimit
        ) RETURNING id`,
        {
          replacements: {
            geocallId: geocallData.id,
            code,
            priority: geocallData.priority,
            type: geocallData.type,
            description: geocallData.description,
            longitude: geocallData.location.longitude,
            latitude: geocallData.location.latitude,
            address: geocallData.address,
            responseTimeLimit
          },
          type: sequelize.QueryTypes.INSERT
        }
      );

      const workOrderId = result[0][0].id;

      logger.info('Work order imported from GEOCALL', {
        geocallId: geocallData.id,
        workOrderId,
        priority: geocallData.priority
      });

      // Se priorità ALTA, attiva assegnazione automatica
      if (geocallData.priority === 'ALTA') {
        setTimeout(async () => {
          try {
            await workOrderService.autoAssignHighPriority(workOrderId);
          } catch (error) {
            logger.error('Error in auto-assignment:', error);
          }
        }, 1000);
      }

      return { id: workOrderId, geocall_id: geocallData.id };

    } catch (error) {
      logger.error('Error importing work order:', error);
      throw error;
    }
  }

  /**
   * Invia aggiornamento stato a GEOCALL
   */
  async sendStatusUpdate(workOrderId) {
    try {
      // Ottieni dati ODL
      const [workOrder] = await sequelize.query(
        `SELECT
          id,
          geocall_id,
          code,
          status,
          priority,
          received_at,
          assigned_at,
          arrival_at,
          work_started_at,
          work_completed_at,
          assigned_team_id
        FROM work_orders
        WHERE id = :workOrderId`,
        {
          replacements: { workOrderId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (!workOrder[0] || !workOrder[0].geocall_id) {
        logger.warn('Work order not from GEOCALL, skip sync');
        return;
      }

      const odl = workOrder[0];

      // Ottieni info squadra
      let teamInfo = null;
      if (odl.assigned_team_id) {
        const [team] = await sequelize.query(
          `SELECT code, name FROM teams WHERE id = :teamId`,
          {
            replacements: { teamId: odl.assigned_team_id },
            type: sequelize.QueryTypes.SELECT
          }
        );
        teamInfo = team[0];
      }

      // Prepara payload
      const payload = {
        work_order_id: odl.geocall_id,
        status: odl.status,
        timestamps: {
          received: odl.received_at,
          assigned: odl.assigned_at,
          arrival: odl.arrival_at,
          work_started: odl.work_started_at,
          work_completed: odl.work_completed_at
        },
        assigned_team: teamInfo ? {
          code: teamInfo.code,
          name: teamInfo.name
        } : null
      };

      // Invia a GEOCALL
      const response = await this.client.post(`/work-orders/${odl.geocall_id}/status`, payload);

      // Log sincronizzazione
      await this.logSync(
        workOrderId,
        'send_status',
        'outgoing',
        payload,
        response.data,
        'success'
      );

      logger.info('Status update sent to GEOCALL', {
        workOrderId,
        geocallId: odl.geocall_id,
        status: odl.status
      });

      return response.data;

    } catch (error) {
      logger.error('Error sending status update to GEOCALL:', error);
      await this.logSync(workOrderId, 'send_status', 'outgoing', null, null, 'error', error.message);
      throw error;
    }
  }

  /**
   * Invia rapportino completato a GEOCALL
   */
  async sendCompletedReport(workOrderId) {
    try {
      // Ottieni dati completi ODL
      const [workOrder] = await sequelize.query(
        `SELECT
          wo.*,
          wor.work_description,
          wor.signature_data,
          wor.signed_at,
          t.code as team_code,
          t.name as team_name
        FROM work_orders wo
        LEFT JOIN work_order_reports wor ON wo.id = wor.work_order_id
        LEFT JOIN teams t ON wo.assigned_team_id = t.id
        WHERE wo.id = :workOrderId`,
        {
          replacements: { workOrderId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (!workOrder[0] || !workOrder[0].geocall_id) {
        throw new Error('Work order not found or not from GEOCALL');
      }

      const odl = workOrder[0];

      // Ottieni foto
      const photos = await sequelize.query(
        `SELECT
          type,
          file_path,
          taken_at,
          description
        FROM work_order_photos
        WHERE work_order_id = :workOrderId
        ORDER BY taken_at`,
        {
          replacements: { workOrderId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      // Ottieni materiali
      const materials = await sequelize.query(
        `SELECT
          material_code,
          material_name,
          quantity,
          unit,
          unit_price,
          total_price
        FROM work_order_materials
        WHERE work_order_id = :workOrderId`,
        {
          replacements: { workOrderId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      // Prepara payload
      const payload = {
        work_order_id: odl.geocall_id,
        completion_data: {
          completed_at: odl.work_completed_at,
          team: {
            code: odl.team_code,
            name: odl.team_name
          },
          work_hours: odl.total_work_hours,
          operators_count: odl.total_operators,
          description: odl.work_description,
          signature: odl.signature_data,
          signed_at: odl.signed_at
        },
        materials: materials,
        photos: photos.map(p => ({
          type: p.type,
          url: `${process.env.BASE_URL}/uploads/photos/${p.file_path}`,
          taken_at: p.taken_at,
          description: p.description
        }))
      };

      // Invia a GEOCALL
      const response = await this.client.post(
        `/work-orders/${odl.geocall_id}/complete`,
        payload
      );

      // Log sincronizzazione
      await this.logSync(
        workOrderId,
        'send_report',
        'outgoing',
        payload,
        response.data,
        'success'
      );

      logger.info('Completion report sent to GEOCALL', {
        workOrderId,
        geocallId: odl.geocall_id
      });

      return response.data;

    } catch (error) {
      logger.error('Error sending completion report to GEOCALL:', error);
      await this.logSync(workOrderId, 'send_report', 'outgoing', null, null, 'error', error.message);
      throw error;
    }
  }

  /**
   * Genera codice univoco ODL
   */
  async generateWorkOrderCode() {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');

    // Conta ODL del mese
    const [count] = await sequelize.query(
      `SELECT COUNT(*) as count
       FROM work_orders
       WHERE EXTRACT(YEAR FROM created_at) = :year
         AND EXTRACT(MONTH FROM created_at) = :month`,
      {
        replacements: {
          year,
          month: new Date().getMonth() + 1
        },
        type: sequelize.QueryTypes.SELECT
      }
    );

    const sequence = String(count[0].count + 1).padStart(4, '0');
    return `ODL-${year}${month}-${sequence}`;
  }

  /**
   * Ottieni tempi di risposta configurati
   */
  async getResponseTimes() {
    const [config] = await sequelize.query(
      `SELECT value FROM system_config WHERE key = 'priority_response_times'`,
      { type: sequelize.QueryTypes.SELECT }
    );

    return config[0].value || {
      'ALTA': 120,
      'MEDIA': 1440,
      'BASSA': null
    };
  }

  /**
   * Log sincronizzazione GEOCALL
   */
  async logSync(workOrderId, syncType, direction, requestPayload, responsePayload, status, errorMessage = null) {
    try {
      await sequelize.query(
        `INSERT INTO geocall_sync_log
         (work_order_id, sync_type, direction, request_payload, response_payload, status, error_message)
         VALUES (:workOrderId, :syncType, :direction, :requestPayload, :responsePayload, :status, :errorMessage)`,
        {
          replacements: {
            workOrderId,
            syncType,
            direction,
            requestPayload: requestPayload ? JSON.stringify(requestPayload) : null,
            responsePayload: responsePayload ? JSON.stringify(responsePayload) : null,
            status,
            errorMessage
          }
        }
      );
    } catch (error) {
      logger.error('Error logging GEOCALL sync:', error);
    }
  }

  /**
   * Avvia polling automatico
   */
  startPolling() {
    logger.info(`Starting GEOCALL polling every ${this.syncInterval}ms`);

    setInterval(async () => {
      try {
        await this.fetchNewWorkOrders();
      } catch (error) {
        logger.error('Error in GEOCALL polling:', error);
      }
    }, this.syncInterval);
  }
}

module.exports = new GeocallService();
