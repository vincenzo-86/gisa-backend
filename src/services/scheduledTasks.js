const cron = require('node-cron');
const logger = require('../utils/logger');
const warehouseService = require('./warehouseService');
const gpsTrackingService = require('./gpsTrackingService');
const geocallService = require('./geocallService');

/**
 * Configurazione e avvio task schedulati
 */

// 1. Controllo scorte minime - ogni giorno alle 07:00
cron.schedule('0 7 * * *', async () => {
  logger.info('Running scheduled task: Check minimum stock');
  try {
    await warehouseService.checkMinimumStock();
  } catch (error) {
    logger.error('Error in scheduled task checkMinimumStock:', error);
  }
});

// 2. Analisi ABC - primo giorno del mese alle 02:00
cron.schedule('0 2 1 * *', async () => {
  logger.info('Running scheduled task: ABC Analysis');
  try {
    await warehouseService.performABCAnalysis();
  } catch (error) {
    logger.error('Error in scheduled task performABCAnalysis:', error);
  }
});

// 3. Cleanup tracce GPS vecchie - ogni domenica alle 03:00
cron.schedule('0 3 * * 0', async () => {
  logger.info('Running scheduled task: Cleanup old GPS tracks');
  try {
    await gpsTrackingService.cleanupOldTracks();
  } catch (error) {
    logger.error('Error in scheduled task cleanupOldTracks:', error);
  }
});

// 4. Polling GEOCALL - ogni 30 secondi (se non configurato diversamente)
if (process.env.GEOCALL_API_URL) {
  cron.schedule('*/30 * * * * *', async () => {
    logger.debug('Running scheduled task: GEOCALL polling');
    try {
      await geocallService.fetchNewWorkOrders();
    } catch (error) {
      logger.error('Error in scheduled task GEOCALL polling:', error);
    }
  });
}

// 5. Previsione consumi magazzino - ogni lunedì alle 06:00
cron.schedule('0 6 * * 1', async () => {
  logger.info('Running scheduled task: Forecast warehouse consumption');
  try {
    // Ottieni tutti gli articoli attivi di classe A e B
    const { sequelize } = require('../config/database');
    const items = await sequelize.query(
      `SELECT id FROM warehouse_items
       WHERE is_active = true AND abc_class IN ('A', 'B')`,
      { type: sequelize.QueryTypes.SELECT }
    );

    for (const item of items) {
      try {
        await warehouseService.forecastConsumption(item.id, 90);
      } catch (error) {
        logger.error(`Error forecasting item ${item.id}:`, error);
      }
    }

    logger.info(`Forecast completed for ${items.length} items`);
  } catch (error) {
    logger.error('Error in scheduled task warehouse forecasting:', error);
  }
});

// 6. Verifica manutenzioni veicoli - ogni giorno alle 08:00
cron.schedule('0 8 * * *', async () => {
  logger.info('Running scheduled task: Check vehicle maintenance');
  try {
    const { sequelize } = require('../config/database');

    // Trova manutenzioni in scadenza entro 7 giorni
    const upcoming = await sequelize.query(
      `SELECT
        vm.id,
        vm.vehicle_id,
        vm.type,
        vm.scheduled_date,
        vm.scheduled_mileage,
        v.code as vehicle_code,
        v.current_mileage
      FROM vehicle_maintenance vm
      JOIN vehicles v ON vm.vehicle_id = v.id
      WHERE vm.status = 'programmata'
        AND (
          vm.scheduled_date <= CURRENT_DATE + INTERVAL '7 days'
          OR (vm.scheduled_mileage IS NOT NULL AND v.current_mileage >= vm.scheduled_mileage - 500)
        )`,
      { type: sequelize.QueryTypes.SELECT }
    );

    for (const maint of upcoming) {
      logger.warn('Vehicle maintenance due soon', {
        vehicleCode: maint.vehicle_code,
        maintenanceType: maint.type,
        scheduledDate: maint.scheduled_date,
        scheduledMileage: maint.scheduled_mileage
      });

      // In produzione: invia notifica
    }

    logger.info(`Found ${upcoming.length} upcoming maintenance tasks`);
  } catch (error) {
    logger.error('Error in scheduled task vehicle maintenance:', error);
  }
});

logger.info('Scheduled tasks initialized');

module.exports = {
  // Esporta funzioni per test o esecuzione manuale
  checkMinimumStock: () => warehouseService.checkMinimumStock(),
  performABCAnalysis: () => warehouseService.performABCAnalysis(),
  cleanupGPSTracks: () => gpsTrackingService.cleanupOldTracks()
};
