const { sequelize } = require('../config/database');
const logger = require('../utils/logger');
const geolib = require('geolib');
const moment = require('moment');

class WorkOrderService {

  /**
   * Algoritmo multicriteriale per l'assegnazione ottimale degli ODL
   * MySQL version - usa ST_Distance_Sphere invece di PostGIS geography
   */
  async calculateOptimalAssignment(workOrderId) {
    try {
      // Ottieni dati ODL
      const [workOrder] = await sequelize.query(
        `SELECT * FROM work_orders WHERE id = :workOrderId`,
        {
          replacements: { workOrderId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (!workOrder) {
        throw new Error('ODL non trovato');
      }

      // Ottieni squadre disponibili o con basso carico
      const teams = await sequelize.query(
        `SELECT
          t.id,
          t.code,
          t.name,
          t.status,
          ST_X(t.current_location) as longitude,
          ST_Y(t.current_location) as latitude,
          v.id as vehicle_id,
          COUNT(DISTINCT wo.id) as active_work_orders
        FROM teams t
        LEFT JOIN vehicles v ON t.id = v.assigned_team_id
        LEFT JOIN work_orders wo ON wo.assigned_team_id = t.id
          AND wo.status NOT IN ('completato', 'validato')
        WHERE t.is_active = true
          AND t.status IN ('disponibile', 'in_viaggio', 'in_lavorazione')
        GROUP BY t.id, t.code, t.name, t.status, t.current_location, v.id`,
        { type: sequelize.QueryTypes.SELECT }
      );

      if (teams.length === 0) {
        throw new Error('Nessuna squadra disponibile');
      }

      // Ottieni configurazione pesi algoritmo
      const weights = await this.getScoringWeights();

      // Calcola score per ogni squadra
      const scoredTeams = [];

      for (const team of teams) {
        const scores = {};

        // 1. CRITERIO DISTANZA (40%)
        scores.distance = await this.calculateDistanceScore(
          workOrder,
          team
        );

        // 2. CRITERIO COMPETENZE (25%)
        scores.competence = await this.calculateCompetenceScore(
          workOrder,
          team
        );

        // 3. CRITERIO MATERIALI (20%)
        scores.materials = await this.calculateMaterialsScore(
          workOrder,
          team
        );

        // 4. CRITERIO CARICO DI LAVORO (15%)
        scores.workload = await this.calculateWorkloadScore(
          team
        );

        // Calcola score totale pesato
        const totalScore = (
          scores.distance * weights.distance +
          scores.competence * weights.competence +
          scores.materials * weights.materials +
          scores.workload * weights.workload
        );

        scoredTeams.push({
          team_id: team.id,
          team_code: team.code,
          team_name: team.name,
          scores: scores,
          total_score: totalScore,
          estimated_arrival_time: this.calculateETA(workOrder, team)
        });
      }

      // Ordina per score decrescente
      scoredTeams.sort((a, b) => b.total_score - a.total_score);

      logger.info('Optimal assignment calculated', {
        workOrderId,
        topTeam: scoredTeams[0],
        totalCandidates: scoredTeams.length
      });

      return scoredTeams;

    } catch (error) {
      logger.error('Error calculating optimal assignment:', error);
      throw error;
    }
  }

  /**
   * Calcola score basato sulla distanza
   * MySQL version - usa geolib per calcoli distanza
   */
  async calculateDistanceScore(workOrder, team) {
    if (!team.latitude || !team.longitude || !workOrder.location) {
      return 0;
    }

    // Estrai coordinate ODL - MySQL version
    const [odlCoords] = await sequelize.query(
      `SELECT ST_X(location) as lon, ST_Y(location) as lat
       FROM work_orders WHERE id = :id`,
      {
        replacements: { id: workOrder.id },
        type: sequelize.QueryTypes.SELECT
      }
    );

    if (!odlCoords || !odlCoords.lon || !odlCoords.lat) return 0;

    // Calcola distanza in metri usando geolib
    const distanceMeters = geolib.getDistance(
      { latitude: team.latitude, longitude: team.longitude },
      { latitude: odlCoords.lat, longitude: odlCoords.lon }
    );

    // Converti in km
    const distanceKm = distanceMeters / 1000;

    // Score: inversamente proporzionale alla distanza
    // Distanza 0 km = score 100
    // Distanza 50 km = score 50
    // Distanza >= 100 km = score 0
    const score = Math.max(0, 100 - distanceKm);

    return score;
  }

  /**
   * Calcola score basato sulle competenze
   */
  async calculateCompetenceScore(workOrder, team) {
    // Ottieni competenze richieste per il tipo di intervento
    const requiredCompetences = await this.getRequiredCompetences(workOrder.type);

    if (requiredCompetences.length === 0) {
      return 100; // Nessuna competenza specifica richiesta
    }

    // Ottieni competenze della squadra
    const [teamCompetences] = await sequelize.query(
      `SELECT COUNT(*) as count
       FROM team_competences
       WHERE team_id = :teamId
         AND competence_type IN (:required)
         AND (expiry_date IS NULL OR expiry_date > CURDATE())`,
      {
        replacements: {
          teamId: team.id,
          required: requiredCompetences
        },
        type: sequelize.QueryTypes.SELECT
      }
    );

    // Percentuale di competenze possedute
    const percentage = (teamCompetences.count / requiredCompetences.length) * 100;

    return percentage;
  }

  /**
   * Calcola score basato sulla disponibilità materiali
   */
  async calculateMaterialsScore(workOrder, team) {
    // Ottieni materiali necessari per tipo intervento
    const requiredMaterials = await this.getRequiredMaterials(workOrder.type);

    if (requiredMaterials.length === 0) {
      return 100; // Nessun materiale specifico richiesto
    }

    // Verifica materiali a bordo del mezzo della squadra
    // Per ora assumiamo che tutti abbiano i materiali base
    // In futuro si può implementare tracking materiali su mezzi

    return 70; // Score medio di default
  }

  /**
   * Calcola score basato sul carico di lavoro
   */
  async calculateWorkloadScore(team) {
    // Score più alto = meno carico di lavoro
    const activeOrders = team.active_work_orders || 0;

    // 0 ODL attivi = score 100
    // 5+ ODL attivi = score 0
    const score = Math.max(0, 100 - (activeOrders * 20));

    return score;
  }

  /**
   * Calcola tempo stimato di arrivo (ETA) in minuti
   */
  calculateETA(workOrder, team) {
    if (!team.latitude || !team.longitude) {
      return null;
    }

    // Distanza in km (semplificato)
    // In produzione usare API routing reale
    const distanceKm = 10; // Placeholder

    // Velocità media 40 km/h in contesto urbano
    const avgSpeedKmh = 40;
    const etaMinutes = Math.ceil((distanceKm / avgSpeedKmh) * 60);

    return etaMinutes;
  }

  /**
   * Ottieni pesi configurati per l'algoritmo
   */
  async getScoringWeights() {
    const [weights] = await sequelize.query(
      `SELECT
        JSON_UNQUOTE(JSON_EXTRACT((SELECT value FROM system_config WHERE \`key\` = 'scoring_weight_distance'), '$')) as distance,
        JSON_UNQUOTE(JSON_EXTRACT((SELECT value FROM system_config WHERE \`key\` = 'scoring_weight_competence'), '$')) as competence,
        JSON_UNQUOTE(JSON_EXTRACT((SELECT value FROM system_config WHERE \`key\` = 'scoring_weight_materials'), '$')) as materials,
        JSON_UNQUOTE(JSON_EXTRACT((SELECT value FROM system_config WHERE \`key\` = 'scoring_weight_workload'), '$')) as workload`,
      { type: sequelize.QueryTypes.SELECT }
    );

    return {
      distance: parseFloat(weights.distance) || 0.40,
      competence: parseFloat(weights.competence) || 0.25,
      materials: parseFloat(weights.materials) || 0.20,
      workload: parseFloat(weights.workload) || 0.15
    };
  }

  /**
   * Ottieni competenze richieste per tipo intervento
   */
  async getRequiredCompetences(workOrderType) {
    // Mapping tipo intervento -> competenze
    const competenceMap = {
      'riparazione_perdita': ['saldatura_polietilene', 'lavori_scavo'],
      'spurgo_fogna': ['autospurgo', 'ambienti_confinati'],
      'sostituzione_pozzetto': ['muratura', 'lavori_scavo'],
      'videoispezione': ['videocamera_fognature', 'interpretazione_immagini']
    };

    return competenceMap[workOrderType] || [];
  }

  /**
   * Ottieni materiali richiesti per tipo intervento
   */
  async getRequiredMaterials(workOrderType) {
    // Mapping tipo intervento -> materiali
    const materialsMap = {
      'riparazione_perdita': ['tubo_pe_100mm', 'raccordi', 'nastro_segnalatore'],
      'spurgo_fogna': [],
      'sostituzione_pozzetto': ['pozzetto_prefabbricato', 'malta', 'chiusino'],
      'videoispezione': []
    };

    return materialsMap[workOrderType] || [];
  }

  /**
   * Assegna ODL a squadra (automatico o semi-automatico)
   * MySQL version
   */
  async assignWorkOrder(workOrderId, teamId, assignedBy, mode = 'semi-automatica') {
    try {
      // Calcola score per logging
      const assignments = await this.calculateOptimalAssignment(workOrderId);
      const selectedTeam = assignments.find(a => a.team_id === teamId);

      // Aggiorna ODL
      await sequelize.query(
        `UPDATE work_orders
         SET assigned_team_id = :teamId,
             assigned_by = :assignedBy,
             assigned_at = NOW(),
             assignment_mode = :mode,
             assignment_score = :score,
             status = 'assegnato',
             updated_at = NOW()
         WHERE id = :workOrderId`,
        {
          replacements: {
            workOrderId,
            teamId,
            assignedBy,
            mode,
            score: selectedTeam?.total_score || 0
          }
        }
      );

      // Registra cambio stato
      await sequelize.query(
        `INSERT INTO work_order_status_history (work_order_id, old_status, new_status, changed_by)
         SELECT :workOrderId, status, 'assegnato', :assignedBy
         FROM work_orders WHERE id = :workOrderId`,
        {
          replacements: { workOrderId, assignedBy }
        }
      );

      logger.info('Work order assigned', {
        workOrderId,
        teamId,
        mode,
        score: selectedTeam?.total_score
      });

      return {
        success: true,
        assignment: selectedTeam
      };

    } catch (error) {
      logger.error('Error assigning work order:', error);
      throw error;
    }
  }

  /**
   * Gestione automatica ODL priorità ALTA
   */
  async autoAssignHighPriority(workOrderId) {
    try {
      // Verifica che sia abilitata l'assegnazione automatica
      const [config] = await sequelize.query(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(value, '$')) as enabled
         FROM system_config
         WHERE \`key\` = 'auto_assignment_high_priority'`,
        { type: sequelize.QueryTypes.SELECT }
      );

      if (config.enabled !== 'true') {
        logger.info('Auto-assignment disabled for high priority');
        return false;
      }

      // Calcola assegnazione ottimale
      const assignments = await this.calculateOptimalAssignment(workOrderId);

      if (assignments.length === 0) {
        throw new Error('Nessuna squadra disponibile per assegnazione automatica');
      }

      // Assegna alla squadra con score più alto
      const bestTeam = assignments[0];
      await this.assignWorkOrder(
        workOrderId,
        bestTeam.team_id,
        null, // Sistema automatico
        'automatica'
      );

      logger.info('High priority work order auto-assigned', {
        workOrderId,
        teamId: bestTeam.team_id,
        score: bestTeam.total_score
      });

      return true;

    } catch (error) {
      logger.error('Error in auto-assignment:', error);
      throw error;
    }
  }

  /**
   * Aggiorna stato ODL - MySQL version
   */
  async updateStatus(workOrderId, newStatus, userId, notes = null) {
    try {
      // Ottieni stato corrente
      const [current] = await sequelize.query(
        `SELECT status FROM work_orders WHERE id = :workOrderId`,
        {
          replacements: { workOrderId },
          type: sequelize.QueryTypes.SELECT
        }
      );

      if (!current) {
        throw new Error('ODL non trovato');
      }

      const oldStatus = current.status;

      // Aggiorna ODL con timestamp appropriato
      const timestampField = this.getTimestampField(newStatus);
      const updateQuery = `
        UPDATE work_orders
        SET status = :newStatus,
            ${timestampField ? `${timestampField} = NOW(),` : ''}
            updated_at = NOW()
        WHERE id = :workOrderId
      `;

      await sequelize.query(updateQuery, {
        replacements: { workOrderId, newStatus }
      });

      // Registra storico
      await sequelize.query(
        `INSERT INTO work_order_status_history
         (work_order_id, old_status, new_status, changed_by, notes)
         VALUES (:workOrderId, :oldStatus, :newStatus, :userId, :notes)`,
        {
          replacements: {
            workOrderId,
            oldStatus,
            newStatus,
            userId,
            notes
          }
        }
      );

      // Aggiorna stato squadra se necessario
      if (newStatus === 'in_viaggio') {
        await this.updateTeamStatus(workOrderId, 'in_viaggio');
      } else if (newStatus === 'in_lavorazione') {
        await this.updateTeamStatus(workOrderId, 'in_lavorazione');
      } else if (newStatus === 'completato') {
        await this.updateTeamStatus(workOrderId, 'disponibile');
      }

      logger.info('Work order status updated', {
        workOrderId,
        oldStatus,
        newStatus,
        userId
      });

      return true;

    } catch (error) {
      logger.error('Error updating work order status:', error);
      throw error;
    }
  }

  /**
   * Ottieni campo timestamp per stato
   */
  getTimestampField(status) {
    const mapping = {
      'assegnato': 'assigned_at',
      'preso_in_carico': 'taken_in_charge_at',
      'in_viaggio': 'departure_at',
      'arrivato_sul_posto': 'arrival_at',
      'in_lavorazione': 'work_started_at',
      'completato': 'work_completed_at',
      'validato': 'validated_at'
    };

    return mapping[status] || null;
  }

  /**
   * Aggiorna stato squadra
   */
  async updateTeamStatus(workOrderId, status) {
    try {
      await sequelize.query(
        `UPDATE teams
         SET status = :status, updated_at = NOW()
         WHERE id = (SELECT assigned_team_id FROM work_orders WHERE id = :workOrderId)`,
        {
          replacements: { workOrderId, status }
        }
      );
    } catch (error) {
      logger.error('Error updating team status:', error);
    }
  }
}

module.exports = new WorkOrderService();
