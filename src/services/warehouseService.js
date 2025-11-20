const { sequelize } = require('../config/database');
const logger = require('../utils/logger');
const moment = require('moment');

class WarehouseService {

  /**
   * Verifica scorte minime e genera alert
   */
  async checkMinimumStock() {
    try {
      logger.info('Checking minimum stock levels...');

      const lowStockItems = await sequelize.query(
        `SELECT
          wi.id,
          wi.code,
          wi.name,
          wi.unit,
          wi.minimum_stock,
          wi.reorder_point,
          wi.reorder_quantity,
          ws.warehouse_id,
          wl.name as warehouse_name,
          ws.quantity as current_stock,
          ws.available_quantity
        FROM warehouse_items wi
        JOIN warehouse_stock ws ON wi.id = ws.item_id
        JOIN warehouse_locations wl ON ws.warehouse_id = wl.id
        WHERE wi.is_active = true
          AND ws.available_quantity < wi.minimum_stock
          AND wi.minimum_stock IS NOT NULL`,
        { type: sequelize.QueryTypes.SELECT }
      );

      logger.info(`Found ${lowStockItems.length} items below minimum stock`);

      for (const item of lowStockItems) {
        // Verifica se esiste già alert non risolto
        const [existingAlert] = await sequelize.query(
          `SELECT id FROM warehouse_alerts
           WHERE item_id = :itemId
             AND warehouse_id = :warehouseId
             AND alert_type = 'scorta_minima'
             AND is_resolved = false
           LIMIT 1`,
          {
            replacements: {
              itemId: item.id,
              warehouseId: item.warehouse_id
            },
            type: sequelize.QueryTypes.SELECT
          }
        );

        if (existingAlert.length > 0) {
          continue; // Alert già esistente
        }

        // Calcola quantità suggerita
        const suggestedQty = item.reorder_quantity || (item.minimum_stock * 2);

        // Crea alert
        await sequelize.query(
          `INSERT INTO warehouse_alerts
           (item_id, warehouse_id, alert_type, description, current_stock, minimum_stock, suggested_order_quantity)
           VALUES (:itemId, :warehouseId, :alertType, :description, :currentStock, :minimumStock, :suggestedQty)`,
          {
            replacements: {
              itemId: item.id,
              warehouseId: item.warehouse_id,
              alertType: item.available_quantity === 0 ? 'scorta_zero' : 'scorta_minima',
              description: `${item.name} sotto scorta minima in ${item.warehouse_name}. Stock attuale: ${item.available_quantity} ${item.unit}, minimo: ${item.minimum_stock} ${item.unit}`,
              currentStock: item.available_quantity,
              minimumStock: item.minimum_stock,
              suggestedQty
            }
          }
        );

        logger.warn('Warehouse alert created', {
          itemCode: item.code,
          itemName: item.name,
          warehouse: item.warehouse_name,
          currentStock: item.available_quantity,
          minimumStock: item.minimum_stock
        });
      }

      return lowStockItems.length;

    } catch (error) {
      logger.error('Error checking minimum stock:', error);
      throw error;
    }
  }

  /**
   * Analisi ABC degli articoli
   */
  async performABCAnalysis() {
    try {
      logger.info('Performing ABC analysis...');

      // Calcola valore totale movimentato negli ultimi 12 mesi per ogni articolo
      const items = await sequelize.query(
        `SELECT
          wi.id,
          wi.code,
          wi.name,
          SUM(ABS(wm.quantity) * wm.unit_price) as total_value,
          SUM(ABS(wm.quantity)) as total_quantity
        FROM warehouse_items wi
        LEFT JOIN warehouse_movements wm ON wi.id = wm.item_id
          AND wm.performed_at > NOW() - INTERVAL '12 months'
        WHERE wi.is_active = true
        GROUP BY wi.id, wi.code, wi.name
        ORDER BY total_value DESC NULLS LAST`,
        { type: sequelize.QueryTypes.SELECT }
      );

      // Calcola totale complessivo
      const totalValue = items.reduce((sum, item) => sum + (parseFloat(item.total_value) || 0), 0);

      // Assegna classi ABC
      let cumulativePercentage = 0;
      let classA = 0, classB = 0, classC = 0;

      for (const item of items) {
        const itemValue = parseFloat(item.total_value) || 0;
        const percentage = totalValue > 0 ? (itemValue / totalValue) * 100 : 0;
        cumulativePercentage += percentage;

        let abcClass;
        if (cumulativePercentage <= 80) {
          abcClass = 'A';
          classA++;
        } else if (cumulativePercentage <= 95) {
          abcClass = 'B';
          classB++;
        } else {
          abcClass = 'C';
          classC++;
        }

        // Calcola indice di rotazione
        const rotationIndex = item.total_quantity || 0;

        // Aggiorna articolo
        await sequelize.query(
          `UPDATE warehouse_items
           SET abc_class = :abcClass,
               rotation_index = :rotationIndex,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = :itemId`,
          {
            replacements: {
              itemId: item.id,
              abcClass,
              rotationIndex
            }
          }
        );
      }

      logger.info('ABC analysis completed', {
        totalItems: items.length,
        classA,
        classB,
        classC
      });

      return {
        totalItems: items.length,
        classA,
        classB,
        classC
      };

    } catch (error) {
      logger.error('Error performing ABC analysis:', error);
      throw error;
    }
  }

  /**
   * Previsione consumi con modello semplificato
   * In produzione usare librerie ML come brain.js, TensorFlow.js o Python service
   */
  async forecastConsumption(itemId, horizonDays = 90) {
    try {
      // Ottieni storico consumi ultimi 12 mesi
      const consumption = await sequelize.query(
        `SELECT
          DATE(wm.performed_at) as date,
          SUM(ABS(wm.quantity)) as quantity
        FROM warehouse_movements wm
        WHERE wm.item_id = :itemId
          AND wm.movement_type IN ('prelievo', 'scarico')
          AND wm.performed_at > NOW() - INTERVAL '12 months'
        GROUP BY DATE(wm.performed_at)
        ORDER BY date ASC`,
        {
          replacements: { itemId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (consumption.length < 30) {
        logger.warn('Insufficient data for forecasting', { itemId });
        return null;
      }

      // Calcola media mobile semplice
      const avgDailyConsumption = consumption.reduce((sum, day) =>
        sum + parseFloat(day.quantity), 0
      ) / consumption.length;

      // Calcola deviazione standard
      const variance = consumption.reduce((sum, day) =>
        sum + Math.pow(parseFloat(day.quantity) - avgDailyConsumption, 2), 0
      ) / consumption.length;
      const stdDev = Math.sqrt(variance);

      // Genera previsioni per i prossimi horizonDays giorni
      const forecasts = [];
      const startDate = moment().add(1, 'day');

      for (let i = 0; i < horizonDays; i++) {
        const forecastDate = moment(startDate).add(i, 'days').format('YYYY-MM-DD');

        // Previsione semplice: media giornaliera
        // In produzione usare ARIMA, Prophet, o reti neurali
        const predicted = avgDailyConsumption;
        const lowerBound = Math.max(0, predicted - (1.96 * stdDev)); // 95% confidence
        const upperBound = predicted + (1.96 * stdDev);

        // Inserisci o aggiorna previsione
        await sequelize.query(
          `INSERT INTO warehouse_consumption_forecast
           (item_id, forecast_date, predicted_consumption, confidence_interval_lower, confidence_interval_upper, model_type)
           VALUES (:itemId, :forecastDate, :predicted, :lower, :upper, 'simple_moving_average')
           ON CONFLICT (item_id, forecast_date)
           DO UPDATE SET
             predicted_consumption = :predicted,
             confidence_interval_lower = :lower,
             confidence_interval_upper = :upper,
             model_type = 'simple_moving_average',
             created_at = CURRENT_TIMESTAMP`,
          {
            replacements: {
              itemId,
              forecastDate,
              predicted: predicted.toFixed(2),
              lower: lowerBound.toFixed(2),
              upper: upperBound.toFixed(2)
            }
          }
        );

        forecasts.push({
          date: forecastDate,
          predicted: parseFloat(predicted.toFixed(2)),
          lower: parseFloat(lowerBound.toFixed(2)),
          upper: parseFloat(upperBound.toFixed(2))
        });
      }

      logger.info('Consumption forecast generated', {
        itemId,
        horizonDays,
        avgDailyConsumption: avgDailyConsumption.toFixed(2)
      });

      return forecasts;

    } catch (error) {
      logger.error('Error forecasting consumption:', error);
      throw error;
    }
  }

  /**
   * Genera automaticamente proposte d'ordine
   */
  async generateOrderProposals() {
    try {
      logger.info('Generating order proposals...');

      // Ottieni articoli sotto scorta minima
      const items = await sequelize.query(
        `SELECT
          wi.id,
          wi.code,
          wi.name,
          wi.minimum_stock,
          wi.reorder_quantity,
          wi.default_supplier_id,
          wi.average_delivery_time,
          ws.available_quantity,
          s.name as supplier_name
        FROM warehouse_items wi
        JOIN warehouse_stock ws ON wi.id = ws.item_id
        LEFT JOIN suppliers s ON wi.default_supplier_id = s.id
        WHERE wi.is_active = true
          AND ws.available_quantity < wi.reorder_point
          AND wi.reorder_quantity IS NOT NULL`,
        { type: sequelize.QueryTypes.SELECT }
      );

      const proposals = items.map(item => ({
        item_id: item.id,
        item_code: item.code,
        item_name: item.name,
        current_stock: item.available_quantity,
        minimum_stock: item.minimum_stock,
        suggested_quantity: item.reorder_quantity,
        supplier_id: item.default_supplier_id,
        supplier_name: item.supplier_name,
        delivery_time_days: item.average_delivery_time
      }));

      logger.info(`Generated ${proposals.length} order proposals`);

      return proposals;

    } catch (error) {
      logger.error('Error generating order proposals:', error);
      throw error;
    }
  }

  /**
   * Registra movimento magazzino
   */
  async recordMovement(movementData) {
    try {
      const {
        itemId,
        warehouseId,
        movementType,
        quantity,
        unitPrice,
        workOrderId,
        teamId,
        supplierId,
        documentNumber,
        notes,
        performedBy
      } = movementData;

      // Calcola prezzo totale
      const totalPrice = unitPrice ? quantity * unitPrice : null;

      // Inserisci movimento
      await sequelize.query(
        `INSERT INTO warehouse_movements
         (item_id, warehouse_id, movement_type, quantity, unit_price, total_price,
          work_order_id, team_id, supplier_id, document_number, notes, performed_by)
         VALUES (:itemId, :warehouseId, :movementType, :quantity, :unitPrice, :totalPrice,
                 :workOrderId, :teamId, :supplierId, :documentNumber, :notes, :performedBy)`,
        {
          replacements: {
            itemId,
            warehouseId,
            movementType,
            quantity,
            unitPrice,
            totalPrice,
            workOrderId,
            teamId,
            supplierId,
            documentNumber,
            notes,
            performedBy
          }
        }
      );

      // Aggiorna giacenza
      const multiplier = ['carico', 'reso'].includes(movementType) ? 1 : -1;
      await sequelize.query(
        `UPDATE warehouse_stock
         SET quantity = quantity + (:quantity * :multiplier),
             updated_at = CURRENT_TIMESTAMP
         WHERE item_id = :itemId AND warehouse_id = :warehouseId`,
        {
          replacements: {
            itemId,
            warehouseId,
            quantity,
            multiplier
          }
        }
      );

      logger.info('Warehouse movement recorded', {
        itemId,
        movementType,
        quantity
      });

      return true;

    } catch (error) {
      logger.error('Error recording warehouse movement:', error);
      throw error;
    }
  }
}

module.exports = new WarehouseService();
