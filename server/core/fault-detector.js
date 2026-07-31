/**
 * Fault Detection Engine
 * 
 * Core algorithm for detecting and localizing faults in the radial distribution
 * network. Works by finding live/dark boundaries in the tree topology.
 * 
 * Key insight: A fault on a span produces a boundary where the parent pole is
 * live and the child pole is dark. Everything downstream of the fault goes dark.
 * The fault is on the EDGE between the last live pole and first dark pole.
 * 
 * Noise filtering:
 * - Dead sensor: single dark pole with live children → not a fault
 * - Scheduled outage: check against outage feed before ticketing
 * - Firmware 1.2.x: no power_lost event, detect via missed heartbeats
 * - Debouncing: 30s wait before creating ticket for transient spikes
 */

const { getDb } = require('../db/connection');
const { getTopology, getDescendants, haversineDistance } = require('./topology-inference');
const { createTicket, updateTicketPoles, findExistingTicket } = require('./ticket-manager');

// Debounce timers per DT
const debounceTimers = new Map();
const DEBOUNCE_MS = 5000; // 5 seconds for demo speed (would be 30s in production)

/**
 * Check if a feeder or DT is under scheduled outage right now
 */
function isScheduledOutage(feederId, dtId) {
  const db = getDb();
  const now = new Date().toISOString();
  
  // Add 40-minute buffer for overruns
  const bufferMs = 40 * 60 * 1000;
  const bufferedNow = new Date(Date.now() - bufferMs).toISOString();
  
  const outage = db.prepare(`
    SELECT * FROM scheduled_outages 
    WHERE is_active = 1 
    AND (
      (scope = 'feeder' AND target_id = ? AND start_time <= ? AND end_time >= ?)
      OR (scope = 'dt' AND target_id = ? AND start_time <= ? AND end_time >= ?)
    )
  `).get(feederId, now, bufferedNow, dtId, now, bufferedNow);
  
  return outage || null;
}

/**
 * Detect if a single dark pole is actually a dead sensor, not a fault.
 * A single dark pole with live children is physically impossible as a line fault.
 */
function isDeadSensor(nodes, poleId) {
  const node = nodes.get(poleId);
  if (!node) return false;
  
  // If pole is dark but has children that are ALL live → dead sensor
  if (!node.energized && node.children.length > 0) {
    const allChildrenLive = node.children.every(childId => {
      const child = nodes.get(childId);
      return child && child.energized;
    });
    if (allChildrenLive) return true;
  }
  
  return false;
}

/**
 * Find all fault boundaries in a DT's topology.
 * A boundary is an edge where the parent is live and the child is dark.
 * Returns array of { spanStart, spanEnd, affectedPoles, confidence, ... }
 */
function findFaultBoundaries(topology) {
  if (!topology || !topology.nodes || !topology.rootId) return [];
  
  const { nodes, rootId, dt, source } = topology;
  const boundaries = [];
  
  // BFS from root, looking for live→dark transitions
  const queue = [rootId];
  const visited = new Set();
  
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    
    const current = nodes.get(currentId);
    if (!current) continue;
    
    // Skip dead sensors
    if (isDeadSensor(nodes, currentId)) {
      // Still traverse children since they're live
      for (const childId of current.children) {
        queue.push(childId);
      }
      continue;
    }
    
    for (const childId of current.children) {
      const child = nodes.get(childId);
      if (!child) continue;
      
      if (current.energized && !child.energized && !isDeadSensor(nodes, childId)) {
        // FAULT BOUNDARY FOUND: current is live, child is dark
        const affectedPoles = [childId, ...getDescendants(nodes, childId)];
        
        // Compute midpoint for fault location
        const faultLat = (current.lat + child.lat) / 2;
        const faultLon = (current.lon + child.lon) / 2;
        
        // Confidence scoring
        let confidence = 0.5;
        const reasons = [];
        
        if (source === 'known') {
          confidence += 0.3;
          reasons.push('Known topology');
        } else {
          confidence += 0.1;
          reasons.push('Inferred topology (lower certainty)');
        }
        
        if (current.deviceId && child.deviceId) {
          confidence += 0.1;
          reasons.push('Both boundary poles have devices');
        } else {
          reasons.push('Device gap at boundary');
        }
        
        if (affectedPoles.length >= 3) {
          confidence += 0.1;
          reasons.push(`${affectedPoles.length} poles affected downstream`);
        }
        
        confidence = Math.min(confidence, 1.0);
        
        // Get pincode
        const pincode = child.pincode || current.pincode || dt.pincode || 'Unknown';
        
        boundaries.push({
          spanStart: currentId,
          spanEnd: childId,
          faultLat,
          faultLon,
          pincode,
          affectedPoles,
          confidence: Math.round(confidence * 100) / 100,
          confidenceReason: reasons.join('; '),
          topologySource: source,
          dtId: dt.dt_id,
          feederId: dt.feeder_id,
        });
      } else if (current.energized) {
        // Current is live, child is live — keep traversing
        queue.push(childId);
      } else {
        // Current is dark — don't create another boundary, this pole is
        // already downstream of a fault
        queue.push(childId);
      }
    }
  }
  
  return boundaries;
}

/**
 * Detect if an entire DT is down (DT-level fault).
 * All poles under this DT are dark, with no live pole beneath it.
 */
function isDTFault(topology) {
  if (!topology || !topology.nodes) return false;
  
  for (const [, node] of topology.nodes) {
    if (node.energized && node.deviceId) return false; // At least one live pole with a device
  }
  
  // Check if there are enough devices reporting dark (not just absent)
  let darkWithDevice = 0;
  let totalWithDevice = 0;
  for (const [, node] of topology.nodes) {
    if (node.deviceId) {
      totalWithDevice++;
      if (!node.energized) darkWithDevice++;
    }
  }
  
  // Need at least 50% of devices to confirm DT-level fault
  return totalWithDevice > 0 && (darkWithDevice / totalWithDevice) > 0.5;
}

/**
 * Main analysis function: analyze a DT for faults.
 * Called when telemetry updates pole state.
 */
function analyzeDT(dtId, broadcast) {
  // Debounce: wait before analyzing to allow burst of signals to arrive
  if (debounceTimers.has(dtId)) {
    clearTimeout(debounceTimers.get(dtId));
  }
  
  debounceTimers.set(dtId, setTimeout(() => {
    debounceTimers.delete(dtId);
    _performAnalysis(dtId, broadcast);
  }, DEBOUNCE_MS));
}

function _performAnalysis(dtId, broadcast) {
  const db = getDb();
  
  // Check scheduled outage first
  const dt = db.prepare('SELECT * FROM transformers WHERE dt_id = ?').get(dtId);
  if (!dt) return;
  
  const outage = isScheduledOutage(dt.feeder_id, dtId);
  if (outage) {
    console.log(`[FaultDetector] Suppressing analysis for ${dtId} — scheduled outage: ${outage.reason}`);
    return;
  }
  
  // Build or infer topology
  const topology = getTopology(dtId);
  if (!topology) return;
  
  // Check for DT-level fault
  if (isDTFault(topology)) {
    const allPoles = Array.from(topology.nodes.keys());
    const existing = findExistingTicket(dtId, 'dt');
    
    if (!existing) {
      const ticket = createTicket({
        faultType: 'dt',
        spanStart: null,
        spanEnd: null,
        faultLat: dt.lat,
        faultLon: dt.lon,
        pincode: topology.nodes.values().next().value?.pincode || 'Unknown',
        feederId: dt.feeder_id,
        dtId: dtId,
        affectedPoles: allPoles,
        confidence: topology.source === 'known' ? 0.85 : 0.65,
        confidenceReason: `All poles under DT ${dtId} are dark — likely DT or upstream fault`,
        topologySource: topology.source,
        severity: 'high',
      });
      
      if (broadcast) broadcast({ type: 'ticket_created', ticket });
      console.log(`[FaultDetector] DT-level fault detected at ${dtId}, ticket ${ticket.ticket_id}`);
    }
    return;
  }
  
  // Find span-level fault boundaries
  const boundaries = findFaultBoundaries(topology);
  
  for (const boundary of boundaries) {
    // Check if we already have a ticket for this span
    const existing = findExistingTicket(dtId, 'span', boundary.spanStart, boundary.spanEnd);
    
    if (!existing) {
      const severity = boundary.affectedPoles.length > 20 ? 'high' : 
                       boundary.affectedPoles.length > 5 ? 'medium' : 'low';
      
      const ticket = createTicket({
        ...boundary,
        faultType: 'span',
        severity,
      });
      
      if (broadcast) broadcast({ type: 'ticket_created', ticket });
      console.log(`[FaultDetector] Span fault: ${boundary.spanStart} → ${boundary.spanEnd}, ${boundary.affectedPoles.length} poles, ticket ${ticket.ticket_id}`);
    }
  }
  
  // Check for auto-verification of existing tickets
  checkAutoVerification(dtId, topology, broadcast);
}

/**
 * Check if existing tickets for this DT can be auto-verified.
 * If all affected poles are now live → move ticket to 'verified'.
 */
function checkAutoVerification(dtId, topology, broadcast) {
  const db = getDb();
  
  const openTickets = db.prepare(`
    SELECT * FROM tickets 
    WHERE dt_id = ? AND status IN ('detected', 'acknowledged', 'crew_assigned', 'resolved')
  `).all(dtId);
  
  for (const ticket of openTickets) {
    const affectedPoles = db.prepare(
      'SELECT pole_id FROM ticket_poles WHERE ticket_id = ?'
    ).all(ticket.ticket_id);
    
    if (affectedPoles.length === 0) continue;
    
    // Check if all affected poles are now energized
    let allLive = true;
    for (const { pole_id } of affectedPoles) {
      const node = topology?.nodes?.get(pole_id);
      if (node && !node.energized) {
        allLive = false;
        break;
      }
      // Also check DB directly if not in topology
      if (!node) {
        const state = db.prepare('SELECT energized FROM pole_state WHERE pole_id = ?').get(pole_id);
        if (state && !state.energized) {
          allLive = false;
          break;
        }
      }
    }
    
    if (allLive) {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE tickets SET status = 'verified', verified_at = ?, updated_at = ? WHERE ticket_id = ?
      `).run(now, now, ticket.ticket_id);
      
      console.log(`[FaultDetector] Ticket ${ticket.ticket_id} auto-verified — all poles restored`);
      
      if (broadcast) {
        broadcast({
          type: 'ticket_updated',
          ticket: { ...ticket, status: 'verified', verified_at: now },
        });
      }
    }
  }
}

/**
 * Analyze all DTs on a feeder (for feeder-level fault detection)
 */
function analyzeFeeder(feederId, broadcast) {
  const db = getDb();
  const dts = db.prepare('SELECT dt_id FROM transformers WHERE feeder_id = ?').all(feederId);
  
  // Check if ALL DTs on this feeder are dark → feeder-level fault
  let allDTsDark = true;
  for (const { dt_id } of dts) {
    const liveCount = db.prepare(`
      SELECT COUNT(*) as c FROM pole_state ps 
      JOIN poles p ON ps.pole_id = p.pole_id 
      WHERE p.dt_id = ? AND ps.energized = 1
    `).get(dt_id);
    if (liveCount.c > 0) {
      allDTsDark = false;
      break;
    }
  }
  
  if (allDTsDark && dts.length > 0) {
    const outage = isScheduledOutage(feederId, null);
    if (outage) {
      console.log(`[FaultDetector] Suppressing feeder fault for ${feederId} — scheduled outage`);
      return;
    }
    
    const existing = db.prepare(`
      SELECT * FROM tickets WHERE feeder_id = ? AND fault_type = 'feeder' AND status NOT IN ('verified', 'closed')
    `).get(feederId);
    
    if (!existing) {
      const feederPoles = db.prepare(`
        SELECT p.pole_id FROM poles p WHERE p.feeder_id = ?
      `).all(feederId);
      
      // Get a representative location
      const firstDT = db.prepare('SELECT * FROM transformers WHERE feeder_id = ? LIMIT 1').get(feederId);
      
      const ticket = createTicket({
        faultType: 'feeder',
        spanStart: null,
        spanEnd: null,
        faultLat: firstDT?.lat || 0,
        faultLon: firstDT?.lon || 0,
        pincode: 'Multiple',
        feederId,
        dtId: null,
        affectedPoles: feederPoles.map(p => p.pole_id),
        confidence: 0.9,
        confidenceReason: `All ${dts.length} DTs on feeder ${feederId} are dark — feeder-level fault`,
        topologySource: 'known',
        severity: 'critical',
      });
      
      if (broadcast) broadcast({ type: 'ticket_created', ticket });
      console.log(`[FaultDetector] Feeder-level fault detected on ${feederId}, ticket ${ticket.ticket_id}`);
    }
  } else {
    // Individual DT analysis
    for (const { dt_id } of dts) {
      analyzeDT(dt_id, broadcast);
    }
  }
}

/**
 * Trigger analysis for a pole's DT after telemetry update
 */
function triggerAnalysis(poleId, broadcast) {
  const db = getDb();
  const pole = db.prepare('SELECT dt_id, feeder_id FROM poles WHERE pole_id = ?').get(poleId);
  if (!pole) return;
  
  analyzeDT(pole.dt_id, broadcast);
}

module.exports = {
  analyzeDT,
  analyzeFeeder,
  triggerAnalysis,
  findFaultBoundaries,
  isScheduledOutage,
  isDeadSensor,
  isDTFault,
  checkAutoVerification,
};
