/**
 * Ticket Manager
 * 
 * Manages the lifecycle of fault tickets:
 * detected → acknowledged → crew_assigned → resolved → verified → closed
 * 
 * Key behaviors:
 * - Auto-verification: when affected poles come back live, ticket moves to 'verified'
 * - Manual resolution rejection: if poles are still dark, system refuses to verify
 * - Grouping: one fault = one ticket, regardless of how many poles are affected
 */

const { getDb } = require('../db/connection');
const { generateSummary } = require('./ai-summary');

let ticketSeq = 0;

function generateTicketId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  ticketSeq++;
  return `TKT-${dateStr}-${String(ticketSeq).padStart(4, '0')}`;
}

/**
 * Create a new fault ticket
 */
function createTicket(faultData) {
  const db = getDb();
  const ticketId = generateTicketId();
  const now = new Date().toISOString();
  
  // Estimate households affected
  let householdsAffected = 0;
  if (faultData.dtId) {
    const dt = db.prepare('SELECT households_served FROM transformers WHERE dt_id = ?').get(faultData.dtId);
    if (dt) {
      // Proportion of poles affected vs total poles on this DT
      const totalPoles = db.prepare('SELECT COUNT(*) as c FROM poles WHERE dt_id = ?').get(faultData.dtId).c;
      const ratio = totalPoles > 0 ? faultData.affectedPoles.length / totalPoles : 1;
      householdsAffected = Math.round(dt.households_served * ratio);
    }
  }
  
  // Generate summary
  const summary = generateSummary({
    ticketId,
    faultType: faultData.faultType,
    spanStart: faultData.spanStart,
    spanEnd: faultData.spanEnd,
    dtId: faultData.dtId,
    feederId: faultData.feederId,
    affectedCount: faultData.affectedPoles.length,
    householdsAffected,
    confidence: faultData.confidence,
    topologySource: faultData.topologySource,
    pincode: faultData.pincode,
  });
  
  db.prepare(`
    INSERT INTO tickets (
      ticket_id, fault_type, status, severity, confidence, confidence_reason,
      fault_span_start, fault_span_end, fault_lat, fault_lon, pincode,
      feeder_id, dt_id, poles_affected, households_affected,
      topology_source, summary, detected_at, updated_at
    ) VALUES (?, ?, 'detected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    faultData.faultType,
    faultData.severity || 'medium',
    faultData.confidence,
    faultData.confidenceReason,
    faultData.spanStart,
    faultData.spanEnd,
    faultData.faultLat,
    faultData.faultLon,
    faultData.pincode,
    faultData.feederId,
    faultData.dtId,
    faultData.affectedPoles.length,
    householdsAffected,
    faultData.topologySource,
    summary,
    now,
    now,
  );
  
  // Insert affected poles
  const insertPole = db.prepare(
    'INSERT OR IGNORE INTO ticket_poles (ticket_id, pole_id, is_boundary) VALUES (?, ?, ?)'
  );
  
  const insertPoles = db.transaction((poles) => {
    for (const poleId of poles) {
      const isBoundary = poleId === faultData.spanStart || poleId === faultData.spanEnd ? 1 : 0;
      insertPole.run(ticketId, poleId, isBoundary);
    }
  });
  
  insertPoles(faultData.affectedPoles);
  
  return db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId);
}

/**
 * Update ticket status with validation
 */
function updateTicketStatus(ticketId, newStatus, broadcast) {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId);
  
  if (!ticket) return { error: 'Ticket not found' };
  
  // Valid transitions
  const validTransitions = {
    'detected': ['acknowledged'],
    'acknowledged': ['crew_assigned'],
    'crew_assigned': ['resolved'],
    'resolved': ['verified', 'crew_assigned'], // Can go back if verification fails
    'verified': ['closed'],
    'closed': [],
  };
  
  if (!validTransitions[ticket.status]?.includes(newStatus)) {
    return { error: `Cannot transition from '${ticket.status}' to '${newStatus}'` };
  }
  
  // Special case: if marking as 'resolved', check if poles are still dark
  if (newStatus === 'resolved') {
    const darkPoles = db.prepare(`
      SELECT COUNT(*) as c FROM ticket_poles tp
      JOIN pole_state ps ON tp.pole_id = ps.pole_id
      WHERE tp.ticket_id = ? AND ps.energized = 0
    `).get(ticketId);
    
    if (darkPoles.c > 0) {
      return { 
        error: `Cannot resolve: ${darkPoles.c} poles are still dark. Restoration must be verified from telemetry.`,
        darkCount: darkPoles.c,
      };
    }
  }
  
  const now = new Date().toISOString();
  const timestampField = `${newStatus}_at`;
  
  db.prepare(`
    UPDATE tickets SET status = ?, ${timestampField} = ?, updated_at = ? WHERE ticket_id = ?
  `).run(newStatus, now, now, ticketId);
  
  const updated = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId);
  
  if (broadcast) {
    broadcast({ type: 'ticket_updated', ticket: updated });
  }
  
  return { ticket: updated };
}

/**
 * Find existing open ticket for a fault location
 */
function findExistingTicket(dtId, faultType, spanStart, spanEnd) {
  const db = getDb();
  
  if (faultType === 'span' && spanStart && spanEnd) {
    return db.prepare(`
      SELECT * FROM tickets 
      WHERE dt_id = ? AND fault_type = 'span' 
      AND fault_span_start = ? AND fault_span_end = ?
      AND status NOT IN ('verified', 'closed')
    `).get(dtId, spanStart, spanEnd);
  }
  
  if (faultType === 'dt') {
    return db.prepare(`
      SELECT * FROM tickets 
      WHERE dt_id = ? AND fault_type = 'dt'
      AND status NOT IN ('verified', 'closed')
    `).get(dtId);
  }
  
  return null;
}

/**
 * Update the poles associated with a ticket
 */
function updateTicketPoles(ticketId, poleIds) {
  const db = getDb();
  
  db.prepare('DELETE FROM ticket_poles WHERE ticket_id = ?').run(ticketId);
  
  const insert = db.prepare(
    'INSERT INTO ticket_poles (ticket_id, pole_id, is_boundary) VALUES (?, ?, 0)'
  );
  
  const insertAll = db.transaction(() => {
    for (const poleId of poleIds) {
      insert.run(ticketId, poleId);
    }
  });
  
  insertAll();
}

/**
 * Get all tickets with optional filters
 */
function getTickets(filters = {}) {
  const db = getDb();
  let query = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];
  
  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  
  if (filters.severity) {
    query += ' AND severity = ?';
    params.push(filters.severity);
  }
  
  if (filters.dtId) {
    query += ' AND dt_id = ?';
    params.push(filters.dtId);
  }
  
  if (filters.feederId) {
    query += ' AND feeder_id = ?';
    params.push(filters.feederId);
  }
  
  if (filters.activeOnly) {
    query += " AND status NOT IN ('verified', 'closed')";
  }
  
  query += ' ORDER BY detected_at DESC';
  
  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }
  
  return db.prepare(query).all(...params);
}

/**
 * Get ticket detail with affected poles
 */
function getTicketDetail(ticketId) {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId);
  if (!ticket) return null;
  
  const poles = db.prepare(`
    SELECT tp.*, p.lat, p.lon, p.device_id, p.ward, p.pincode,
           ps.energized, ps.last_seen
    FROM ticket_poles tp
    JOIN poles p ON tp.pole_id = p.pole_id
    LEFT JOIN pole_state ps ON tp.pole_id = ps.pole_id
    WHERE tp.ticket_id = ?
  `).all(ticketId);
  
  return { ...ticket, poles };
}

module.exports = {
  createTicket,
  updateTicketStatus,
  findExistingTicket,
  updateTicketPoles,
  getTickets,
  getTicketDetail,
  generateTicketId,
};
