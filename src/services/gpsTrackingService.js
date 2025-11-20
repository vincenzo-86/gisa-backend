const { sequelize } = require('../config/database_mysql');
const logger = require('../utils/logger');
const geolib = require('geolib');

class GpsTrackingService {

  /**
   * Aggiorna posizione GPS del veicolo - MySQL version
   */
  async updateVehicleLocation(vehicleId, location, speed, heading, altitude = null) {
    try {
      const { latitude, longitude } = location;

      // Inserisci traccia GPS - MySQL usa POINT(lon, lat) e SRID
      await sequelize.query(
        `INSERT INTO vehicle_gps_tracks
         (vehicle_id, location, speed, heading, altitude, timestamp)
         VALUES (
           :vehicleId,
           ST_GeomFromText('POINT(:longitude :latitude)', 4326),
           :speed,
           :heading,
           :altitude,
           NOW()
         )`,
        {
          replacements: {
            vehicleId,
            longitude,
            latitude,
            speed,
            heading,
            altitude
          }
        }
      );

      // Aggiorna posizione corrente del veicolo
      await sequelize.query(
        `UPDATE vehicles
         SET current_location = ST_GeomFromText('POINT(:longitude :latitude)', 4326),
             last_location_update = NOW(),
             updated_at = NOW()
         WHERE id = :vehicleId`,
        {
          replacements: {
            vehicleId,
            longitude,
            latitude
          }
        }
      );

      // Aggiorna anche la posizione della squadra associata
      await sequelize.query(
        `UPDATE teams
         SET current_location = ST_GeomFromText('POINT(:longitude :latitude)', 4326),
             last_location_update = NOW(),
             updated_at = NOW()
         WHERE id = (SELECT assigned_team_id FROM vehicles WHERE id = :vehicleId)`,
        {
          replacements: {
            vehicleId,
            longitude,
            latitude
          }
        }
      );

      // Controlla comportamenti anomali
      await this.checkAnomalies(vehicleId, speed);

      logger.debug('Vehicle location updated', {
        vehicleId,
        latitude,
        longitude,
        speed
      });

      return true;

    } catch (error) {
      logger.error('Error updating vehicle location:', error);
      throw error;
    }
  }

  /**
   * Controlla comportamenti anomali
   */
  async checkAnomalies(vehicleId, speed) {
    try {
      // Velocità eccessiva (> 90 km/h)
      if (speed > 90) {
        await this.createAlert(
          vehicleId,
          'velocita_eccessiva',
          `Velocità rilevata: ${speed} km/h`,
          'medium'
        );
      }

      // Uso fuori orario (solo se non in emergenza)
      const currentHour = new Date().getHours();
      if (currentHour >= 22 || currentHour < 6) {
        const isEmergency = await this.isVehicleInEmergency(vehicleId);
        if (!isEmergency) {
          await this.createAlert(
            vehicleId,
            'uso_fuori_orario',
            `Movimento rilevato alle ${new Date().toLocaleTimeString()}`,
            'low'
          );
        }
      }

    } catch (error) {
      logger.error('Error checking anomalies:', error);
    }
  }

  /**
   * Crea alert per veicolo
   */
  async createAlert(vehicleId, alertType, description, severity) {
    try {
      // Verifica se esiste già alert simile non risolto nelle ultime 24h
      const [existing] = await sequelize.query(
        `SELECT id FROM vehicle_alerts
         WHERE vehicle_id = :vehicleId
           AND alert_type = :alertType
           AND is_resolved = 0
           AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
         LIMIT 1`,
        {
          replacements: { vehicleId, alertType },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (existing.length > 0) {
        return; // Alert già esistente
      }

      await sequelize.query(
        `INSERT INTO vehicle_alerts
         (vehicle_id, alert_type, description, severity)
         VALUES (:vehicleId, :alertType, :description, :severity)`,
        {
          replacements: {
            vehicleId,
            alertType,
            description,
            severity
          }
        }
      );

      logger.warn('Vehicle alert created', {
        vehicleId,
        alertType,
        description,
        severity
      });

    } catch (error) {
      logger.error('Error creating vehicle alert:', error);
    }
  }

  /**
   * Verifica se veicolo è in emergenza
   */
  async isVehicleInEmergency(vehicleId) {
    const [result] = await sequelize.query(
      `SELECT COUNT(*) as count
       FROM emergency_teams et
       JOIN emergencies e ON et.emergency_id = e.id
       JOIN vehicles v ON et.team_id = v.assigned_team_id
       WHERE v.id = :vehicleId
         AND e.status IN ('attiva', 'in_gestione')
         AND et.status IN ('allertata', 'in_viaggio', 'sul_posto')`,
      {
        replacements: { vehicleId },
        type: sequelize.QueryTypes.SELECT
      }
    );

    return result.count > 0;
  }

  /**
   * Calcola chilometri percorsi nel periodo - MySQL version
   */
  async calculateMileage(vehicleId, startDate, endDate) {
    try {
      // Ottieni tracce GPS nel periodo
      const tracks = await sequelize.query(
        `SELECT
           ST_X(location) as longitude,
           ST_Y(location) as latitude,
           timestamp
         FROM vehicle_gps_tracks
         WHERE vehicle_id = :vehicleId
           AND timestamp BETWEEN :startDate AND :endDate
         ORDER BY timestamp ASC`,
        {
          replacements: {
            vehicleId,
            startDate,
            endDate
          },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (tracks.length < 2) {
        return 0;
      }

      // Calcola distanza totale tra punti consecutivi usando geolib
      let totalDistanceMeters = 0;
      for (let i = 1; i < tracks.length; i++) {
        const prev = {
          latitude: tracks[i - 1].latitude,
          longitude: tracks[i - 1].longitude
        };
        const curr = {
          latitude: tracks[i].latitude,
          longitude: tracks[i].longitude
        };

        const distance = geolib.getDistance(prev, curr);
        totalDistanceMeters += distance;
      }

      // Converti in km
      const totalDistanceKm = totalDistanceMeters / 1000;

      logger.info('Mileage calculated', {
        vehicleId,
        startDate,
        endDate,
        distanceKm: totalDistanceKm.toFixed(2),
        trackPoints: tracks.length
      });

      return parseFloat(totalDistanceKm.toFixed(2));

    } catch (error) {
      logger.error('Error calculating mileage:', error);
      throw error;
    }
  }

  /**
   * Calcola emissioni CO2 nel periodo
   */
  async calculateEmissions(vehicleId, startDate, endDate) {
    try {
      // Ottieni km percorsi
      const km = await this.calculateMileage(vehicleId, startDate, endDate);

      // Ottieni fattore emissione veicolo
      const [vehicle] = await sequelize.query(
        `SELECT co2_emission_factor FROM vehicles WHERE id = :vehicleId`,
        {
          replacements: { vehicleId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (!vehicle || !vehicle.co2_emission_factor) {
        logger.warn('CO2 emission factor not set for vehicle', { vehicleId });
        return 0;
      }

      // Calcola emissioni (grammi CO2 per km * km percorsi / 1000 per ottenere kg)
      const emissionsKg = (vehicle.co2_emission_factor * km) / 1000;

      logger.info('Emissions calculated', {
        vehicleId,
        km,
        emissionFactor: vehicle.co2_emission_factor,
        emissionsKg: emissionsKg.toFixed(2)
      });

      return parseFloat(emissionsKg.toFixed(2));

    } catch (error) {
      logger.error('Error calculating emissions:', error);
      throw error;
    }
  }

  /**
   * Cleanup tracce GPS vecchie
   */
  async cleanupOldTracks() {
    try {
      const retentionDays = parseInt(process.env.GPS_RETENTION_DAYS) || 365;

      const [result] = await sequelize.query(
        `DELETE FROM vehicle_gps_tracks
         WHERE timestamp < DATE_SUB(NOW(), INTERVAL :retentionDays DAY)`,
        {
          replacements: { retentionDays }
        }
      );

      logger.info('Old GPS tracks cleaned up', {
        retentionDays,
        deletedCount: result.affectedRows || 0
      });

    } catch (error) {
      logger.error('Error cleaning up old tracks:', error);
    }
  }

  /**
   * Ottieni traccia completa veicolo per periodo
   */
  async getVehicleTrack(vehicleId, startDate, endDate) {
    try {
      const tracks = await sequelize.query(
        `SELECT
           ST_X(location) as longitude,
           ST_Y(location) as latitude,
           speed,
           heading,
           altitude,
           timestamp
         FROM vehicle_gps_tracks
         WHERE vehicle_id = :vehicleId
           AND timestamp BETWEEN :startDate AND :endDate
         ORDER BY timestamp ASC`,
        {
          replacements: {
            vehicleId,
            startDate,
            endDate
          },
          type: sequelize.QueryTypes.SELECT
        }
      );

      return tracks;

    } catch (error) {
      logger.error('Error getting vehicle track:', error);
      throw error;
    }
  }
}

module.exports = new GpsTrackingService();
