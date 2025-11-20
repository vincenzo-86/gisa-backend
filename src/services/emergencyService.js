const { sequelize } = require('../config/database');
const logger = require('../utils/logger');

class EmergencyService {

  /**
   * Attiva protocollo emergenza
   */
  async activateEmergency(emergencyData, activatedBy) {
    try {
      const {
        type,
        description,
        location,
        address,
        severity,
        teamsRequired,
        estimatedDuration
      } = emergencyData;

      // Genera codice emergenza
      const code = await this.generateEmergencyCode();

      // Crea emergenza
      const [result] = await sequelize.query(
        `INSERT INTO emergencies (
          code,
          type,
          description,
          location,
          address,
          severity,
          status,
          activated_at,
          activated_by,
          teams_required,
          estimated_duration
        ) VALUES (
          :code,
          :type,
          :description,
          ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326),
          :address,
          :severity,
          'attiva',
          CURRENT_TIMESTAMP,
          :activatedBy,
          :teamsRequired,
          :estimatedDuration
        ) RETURNING id`,
        {
          replacements: {
            code,
            type,
            description,
            longitude: location.longitude,
            latitude: location.latitude,
            address,
            severity,
            activatedBy,
            teamsRequired,
            estimatedDuration
          },
          type: sequelize.QueryTypes.INSERT
        }
      );

      const emergencyId = result[0][0].id;

      // Log timeline
      await this.logTimeline(
        emergencyId,
        'emergenza_attivata',
        'Protocollo emergenza attivato',
        activatedBy
      );

      logger.warn('Emergency protocol activated', {
        emergencyId,
        code,
        type,
        severity,
        teamsRequired
      });

      // Blocca assegnazioni automatiche ODL non prioritari
      await this.pauseNonPriorityAssignments();

      // Identifica squadre da mobilitare
      const teams = await this.identifyTeamsToMobilize(
        emergencyId,
        location,
        teamsRequired
      );

      // Mobilita squadre
      for (const team of teams) {
        await this.mobilizeTeam(emergencyId, team.id, activatedBy);
      }

      return {
        emergencyId,
        code,
        mobilizedTeams: teams
      };

    } catch (error) {
      logger.error('Error activating emergency:', error);
      throw error;
    }
  }

  /**
   * Identifica squadre da mobilitare
   */
  async identifyTeamsToMobilize(emergencyId, location, teamsRequired) {
    try {
      // Query per trovare squadre ottimali
      const teams = await sequelize.query(
        `SELECT
          t.id,
          t.code,
          t.name,
          t.status,
          ST_X(t.current_location::geometry) as longitude,
          ST_Y(t.current_location::geometry) as latitude,
          ST_Distance(
            t.current_location,
            ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography
          ) / 1000 as distance_km,
          COUNT(wo.id) as active_work_orders
        FROM teams t
        LEFT JOIN work_orders wo ON wo.assigned_team_id = t.id
          AND wo.status NOT IN ('completato', 'validato')
        WHERE t.is_active = true
          AND t.status != 'fuori_servizio'
        GROUP BY t.id, t.code, t.name, t.status, t.current_location
        ORDER BY distance_km ASC, active_work_orders ASC
        LIMIT :teamsRequired`,
        {
          replacements: {
            longitude: location.longitude,
            latitude: location.latitude,
            teamsRequired
          },
          type: sequelize.QueryTypes.SELECT
        }
      );

      logger.info('Teams identified for emergency', {
        emergencyId,
        teamsCount: teams.length,
        teamsRequired
      });

      return teams;

    } catch (error) {
      logger.error('Error identifying teams:', error);
      throw error;
    }
  }

  /**
   * Mobilita squadra per emergenza
   */
  async mobilizeTeam(emergencyId, teamId, mobilizedBy) {
    try {
      // Inserisci team in emergenza
      await sequelize.query(
        `INSERT INTO emergency_teams (emergency_id, team_id, mobilized_at, status)
         VALUES (:emergencyId, :teamId, CURRENT_TIMESTAMP, 'allertata')`,
        {
          replacements: { emergencyId, teamId }
        }
      );

      // Aggiorna stato squadra
      await sequelize.query(
        `UPDATE teams
         SET status = 'in_viaggio', updated_at = CURRENT_TIMESTAMP
         WHERE id = :teamId`,
        {
          replacements: { teamId }
        }
      );

      // Sospendi ODL in corso non prioritari
      await sequelize.query(
        `UPDATE work_orders
         SET status = 'sospeso',
             notes = CONCAT(COALESCE(notes, ''), '\nSospeso per emergenza ', :emergencyId::text)
         WHERE assigned_team_id = :teamId
           AND status IN ('assegnato', 'in_viaggio')
           AND priority != 'ALTA'`,
        {
          replacements: { teamId, emergencyId }
        }
      );

      logger.info('Team mobilized for emergency', {
        emergencyId,
        teamId
      });

    } catch (error) {
      logger.error('Error mobilizing team:', error);
      throw error;
    }
  }

  /**
   * Sospendi assegnazioni automatiche non prioritarie
   */
  async pauseNonPriorityAssignments() {
    // In produzione questo potrebbe aggiornare una flag in cache (Redis)
    // Per ora logghiamo
    logger.info('Non-priority automatic assignments paused');
  }

  /**
   * Riprendi assegnazioni automatiche
   */
  async resumeNonPriorityAssignments() {
    logger.info('Non-priority automatic assignments resumed');
  }

  /**
   * Deattiva emergenza
   */
  async deactivateEmergency(emergencyId, deactivatedBy) {
    try {
      // Aggiorna emergenza
      await sequelize.query(
        `UPDATE emergencies
         SET status = 'risolta',
             deactivated_at = CURRENT_TIMESTAMP,
             deactivated_by = :deactivatedBy,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = :emergencyId`,
        {
          replacements: { emergencyId, deactivatedBy }
        }
      );

      // Smobilita squadre
      await sequelize.query(
        `UPDATE emergency_teams
         SET status = 'smobilitata',
             demobilized_at = CURRENT_TIMESTAMP
         WHERE emergency_id = :emergencyId
           AND status != 'smobilitata'`,
        {
          replacements: { emergencyId }
        }
      );

      // Ripristina stato squadre
      const [teams] = await sequelize.query(
        `SELECT team_id FROM emergency_teams
         WHERE emergency_id = :emergencyId`,
        {
          replacements: { emergencyId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      for (const team of teams) {
        await sequelize.query(
          `UPDATE teams
           SET status = 'disponibile', updated_at = CURRENT_TIMESTAMP
           WHERE id = :teamId`,
          {
            replacements: { teamId: team.team_id }
          }
        );
      }

      // Log timeline
      await this.logTimeline(
        emergencyId,
        'emergenza_risolta',
        'Emergenza risolta e squadre smobilitate',
        deactivatedBy
      );

      // Riprendi assegnazioni automatiche
      await this.resumeNonPriorityAssignments();

      // Genera report emergenza
      const report = await this.generateEmergencyReport(emergencyId);

      logger.info('Emergency deactivated', {
        emergencyId,
        deactivatedBy
      });

      return report;

    } catch (error) {
      logger.error('Error deactivating emergency:', error);
      throw error;
    }
  }

  /**
   * Invia messaggio in chat emergenza
   */
  async sendChatMessage(emergencyId, userId, message, messageType = 'text', attachmentPath = null) {
    try {
      await sequelize.query(
        `INSERT INTO emergency_chat_messages
         (emergency_id, user_id, message, message_type, attachment_path)
         VALUES (:emergencyId, :userId, :message, :messageType, :attachmentPath)`,
        {
          replacements: {
            emergencyId,
            userId,
            message,
            messageType,
            attachmentPath
          }
        }
      );

      logger.debug('Emergency chat message sent', {
        emergencyId,
        userId,
        messageType
      });

      return true;

    } catch (error) {
      logger.error('Error sending chat message:', error);
      throw error;
    }
  }

  /**
   * Log evento in timeline emergenza
   */
  async logTimeline(emergencyId, eventType, description, performedBy) {
    try {
      await sequelize.query(
        `INSERT INTO emergency_timeline
         (emergency_id, event_type, description, performed_by)
         VALUES (:emergencyId, :eventType, :description, :performedBy)`,
        {
          replacements: {
            emergencyId,
            eventType,
            description,
            performedBy
          }
        }
      );
    } catch (error) {
      logger.error('Error logging emergency timeline:', error);
    }
  }

  /**
   * Genera report emergenza
   */
  async generateEmergencyReport(emergencyId) {
    try {
      // Ottieni dati emergenza
      const [emergency] = await sequelize.query(
        `SELECT
          e.*,
          u1.username as activated_by_username,
          u2.username as deactivated_by_username
        FROM emergencies e
        LEFT JOIN users u1 ON e.activated_by = u1.id
        LEFT JOIN users u2 ON e.deactivated_by = u2.id
        WHERE e.id = :emergencyId`,
        {
          replacements: { emergencyId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (!emergency[0]) {
        throw new Error('Emergency not found');
      }

      const e = emergency[0];

      // Ottieni squadre mobilitate
      const teams = await sequelize.query(
        `SELECT
          et.*,
          t.code as team_code,
          t.name as team_name
        FROM emergency_teams et
        JOIN teams t ON et.team_id = t.id
        WHERE et.emergency_id = :emergencyId
        ORDER BY et.mobilized_at`,
        {
          replacements: { emergencyId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      // Ottieni timeline
      const timeline = await sequelize.query(
        `SELECT
          etl.*,
          u.username as performed_by_username
        FROM emergency_timeline etl
        LEFT JOIN users u ON etl.performed_by = u.id
        WHERE etl.emergency_id = :emergencyId
        ORDER BY etl.created_at`,
        {
          replacements: { emergencyId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      // Calcola durata
      const duration = e.deactivated_at && e.activated_at
        ? Math.round((new Date(e.deactivated_at) - new Date(e.activated_at)) / 1000 / 60)
        : null;

      const report = {
        emergency: {
          code: e.code,
          type: e.type,
          description: e.description,
          severity: e.severity,
          activated_at: e.activated_at,
          deactivated_at: e.deactivated_at,
          duration_minutes: duration,
          activated_by: e.activated_by_username,
          deactivated_by: e.deactivated_by_username
        },
        teams: teams.map(t => ({
          code: t.team_code,
          name: t.team_name,
          mobilized_at: t.mobilized_at,
          arrived_at: t.arrived_at,
          demobilized_at: t.demobilized_at,
          status: t.status
        })),
        timeline: timeline
      };

      return report;

    } catch (error) {
      logger.error('Error generating emergency report:', error);
      throw error;
    }
  }

  /**
   * Genera codice emergenza
   */
  async generateEmergencyCode() {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');

    const [count] = await sequelize.query(
      `SELECT COUNT(*) as count
       FROM emergencies
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

    const sequence = String(count[0].count + 1).padStart(3, '0');
    return `EMG-${year}${month}-${sequence}`;
  }
}

module.exports = new EmergencyService();
