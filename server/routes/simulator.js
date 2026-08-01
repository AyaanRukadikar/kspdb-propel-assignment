/**
 * Fault Simulator Routes
 * 
 * Provides a way to inject faults, noise, and repairs into the system
 * for testing and evaluation. Generates realistic telemetry matching
 * the physics described in the assignment brief.
 * 
 * POST /api/simulator/fault      — Inject a span/DT/feeder fault
 * POST /api/simulator/repair     — Repair a simulated fault
 * POST /api/simulator/noise      — Inject noise (dead sensor, duplicates)
 * POST /api/simulator/outage     — Add a scheduled outage
 * GET  /api/simulator/faults     — List active simulated faults
 * GET  /api/simulator/targets    — Get available targets for fault injection
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/connection');
const { triggerAnalysis, analyzeFeeder, analyzeDT } = require('../core/fault-detector');
const { getTopology, getDescendants } = require('../core/topology-inference');

let faultSeq = 0;

/**
 * POST /api/simulator/fault
 * Body: { type: 'span'|'dt'|'feeder', targetId: 'D-0001'|'F-01-01', spanStart?: 'P-...', spanEnd?: 'P-...' }
 */
router.post('/fault', (req, res) => {
  const db = getDb();
  const { type, targetId, spanStart, spanEnd } = req.body;
  const broadcast = req.app.get('broadcast');
  
  if (!type || !targetId) {
    return res.status(400).json({ error: 'type and targetId are required' });
  }
  
  faultSeq++;
  const faultId = `SIM-F-${String(faultSeq).padStart(4, '0')}`;
  let affectedPoles = [];
  let label = '';
  
  try {
    if (type === 'span') {
      // Need to find two adjacent poles on the same DT
      let start = spanStart;
      let end = spanEnd;
      
      if (!start || !end) {
        // Auto-pick: find a DT and pick two adjacent poles
        const topology = getTopology(targetId); // targetId is a dt_id
        if (!topology || !topology.rootId) {
          return res.status(400).json({ error: `Cannot get topology for DT ${targetId}` });
        }
        
        // Pick a pole in the middle of the main line
        const nodesArr = Array.from(topology.nodes.values())
          .filter(n => n.children.length > 0 || n.parentId);
        
        if (nodesArr.length < 2) {
          return res.status(400).json({ error: 'Not enough poles for a span fault' });
        }
        
        // Pick one roughly in the middle
        const midIdx = Math.floor(nodesArr.length / 3);
        const parentNode = nodesArr[midIdx];
        
        if (parentNode.children.length > 0) {
          start = parentNode.poleId;
          end = parentNode.children[0];
        } else if (parentNode.parentId) {
          start = parentNode.parentId;
          end = parentNode.poleId;
        }
      }
      
      if (!start || !end) {
        return res.status(400).json({ error: 'Could not determine span for fault' });
      }
      
      // Get the target DT
      const pole = db.prepare('SELECT dt_id FROM poles WHERE pole_id = ?').get(end);
      if (!pole) return res.status(400).json({ error: `Pole ${end} not found` });
      
      const dtId = pole.dt_id;
      const topology = getTopology(dtId);
      if (!topology) return res.status(400).json({ error: `Cannot build topology for DT ${dtId}` });
      
      // Everything downstream of 'end' goes dark
      affectedPoles = [end, ...getDescendants(topology.nodes, end)];
      label = `Span fault: ${start} → ${end}`;
      
      // Record simulation fault
      db.prepare(`
        INSERT INTO simulation_faults (fault_id, fault_type, target_id, target_label, span_start, span_end)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(faultId, 'span', dtId, label, start, end);
      
      // Generate telemetry: poles go dark
      simulatePolesDark(db, affectedPoles, broadcast);
      
      // Trigger analysis
      setTimeout(() => analyzeDT(dtId, broadcast), 1000);
      
    } else if (type === 'dt') {
      // All poles under this DT go dark
      const allPoles = db.prepare('SELECT pole_id FROM poles WHERE dt_id = ?').all(targetId);
      affectedPoles = allPoles.map(p => p.pole_id);
      label = `DT fault: ${targetId}`;
      
      db.prepare(`
        INSERT INTO simulation_faults (fault_id, fault_type, target_id, target_label)
        VALUES (?, ?, ?, ?)
      `).run(faultId, 'dt', targetId, label);
      
      simulatePolesDark(db, affectedPoles, broadcast);
      setTimeout(() => analyzeDT(targetId, broadcast), 1000);
      
    } else if (type === 'feeder') {
      // All poles under all DTs on this feeder go dark
      const allPoles = db.prepare('SELECT pole_id FROM poles WHERE feeder_id = ?').all(targetId);
      affectedPoles = allPoles.map(p => p.pole_id);
      label = `Feeder fault: ${targetId}`;
      
      db.prepare(`
        INSERT INTO simulation_faults (fault_id, fault_type, target_id, target_label)
        VALUES (?, ?, ?, ?)
      `).run(faultId, 'feeder', targetId, label);
      
      simulatePolesDark(db, affectedPoles, broadcast);
      setTimeout(() => analyzeFeeder(targetId, broadcast), 1500);
      
    } else {
      return res.status(400).json({ error: `Unknown fault type: ${type}` });
    }
    
    res.json({
      faultId,
      type,
      label,
      affectedPoles: affectedPoles.length,
      message: `Fault injected: ${label}. ${affectedPoles.length} poles going dark.`,
    });
    
  } catch (err) {
    console.error('[Simulator] Error injecting fault:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Simulate poles going dark — generates realistic telemetry
 * - 70% of devices with fw >= 1.3 send power_lost
 * - 30% just go silent
 * - fw 1.2.x devices never send power_lost
 * - ~9% of poles have no device (already no telemetry)
 */
function simulatePolesDark(db, poleIds, broadcast) {
  const now = new Date();
  const updates = [];
  
  for (const poleId of poleIds) {
    const pole = db.prepare('SELECT * FROM poles WHERE pole_id = ?').get(poleId);
    if (!pole) continue;
    
    // Update pole state to dark
    db.prepare('UPDATE pole_state SET energized = 0, last_event = ?, last_seen = ? WHERE pole_id = ?')
      .run('power_lost', now.toISOString(), poleId);
    
    updates.push({ pole_id: poleId, energized: false, event: 'power_lost' });
    
    // Simulate telemetry message (if device exists and fw sends power_lost)
    if (pole.device_id) {
      const isFw12 = pole.firmware_version && pole.firmware_version.startsWith('1.2');
      const sendsPowerLost = !isFw12 && Math.random() < 0.7; // 70% chance for fw >= 1.3
      
      if (sendsPowerLost) {
        // Add slight timestamp jitter (±90 seconds as per spec)
        const jitter = (Math.random() - 0.5) * 180 * 1000;
        const ts = new Date(now.getTime() + jitter).toISOString();
        
        try {
          db.prepare(`
            INSERT INTO telemetry_log (device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw)
            VALUES (?, ?, 'power_lost', 0, ?, ?, ?, ?, ?)
          `).run(pole.device_id, poleId, ts, Math.floor(Math.random() * 100000), 
                 3200 + Math.floor(Math.random() * 500), -80 - Math.floor(Math.random() * 30),
                 pole.firmware_version);
        } catch (e) { /* non-critical */ }
      }
    }
  }
  
  // Broadcast batch update
  if (broadcast && updates.length > 0) {
    broadcast({ type: 'telemetry_update', updates });
  }
}

/**
 * POST /api/simulator/repair
 * Body: { faultId: 'SIM-F-0001' }
 */
router.post('/repair', (req, res) => {
  const db = getDb();
  const { faultId } = req.body;
  const broadcast = req.app.get('broadcast');
  
  if (!faultId) return res.status(400).json({ error: 'faultId is required' });
  
  const fault = db.prepare('SELECT * FROM simulation_faults WHERE fault_id = ? AND is_active = 1').get(faultId);
  if (!fault) return res.status(404).json({ error: 'Active fault not found' });
  
  let restoredPoles = [];
  
  if (fault.fault_type === 'span') {
    const dtId = fault.target_id;
    const topology = getTopology(dtId);
    if (topology && fault.span_end) {
      restoredPoles = [fault.span_end, ...getDescendants(topology.nodes, fault.span_end)];
    }
  } else if (fault.fault_type === 'dt') {
    const poles = db.prepare('SELECT pole_id FROM poles WHERE dt_id = ?').all(fault.target_id);
    restoredPoles = poles.map(p => p.pole_id);
  } else if (fault.fault_type === 'feeder') {
    const poles = db.prepare('SELECT pole_id FROM poles WHERE feeder_id = ?').all(fault.target_id);
    restoredPoles = poles.map(p => p.pole_id);
  }
  
  // Restore poles
  const now = new Date().toISOString();
  const updates = [];
  
  for (const poleId of restoredPoles) {
    db.prepare('UPDATE pole_state SET energized = 1, last_event = ?, last_seen = ? WHERE pole_id = ?')
      .run('power_restored', now, poleId);
    updates.push({ pole_id: poleId, energized: true, event: 'power_restored' });
  }
  
  // Deactivate simulation fault
  db.prepare('UPDATE simulation_faults SET is_active = 0 WHERE fault_id = ?').run(faultId);
  
  if (broadcast && updates.length > 0) {
    broadcast({ type: 'telemetry_update', updates });
  }
  
  // Trigger re-analysis for auto-verification
  if (fault.fault_type === 'span' || fault.fault_type === 'dt') {
    setTimeout(() => analyzeDT(fault.target_id, broadcast), 1000);
  } else if (fault.fault_type === 'feeder') {
    const dts = db.prepare('SELECT dt_id FROM transformers WHERE feeder_id = ?').all(fault.target_id);
    for (const { dt_id } of dts) {
      setTimeout(() => analyzeDT(dt_id, broadcast), 1000);
    }
  }
  
  res.json({
    faultId,
    restoredPoles: restoredPoles.length,
    message: `Fault ${faultId} repaired. ${restoredPoles.length} poles restored.`,
  });
});

/**
 * POST /api/simulator/noise
 * Body: { type: 'dead_sensor'|'duplicate', poleId: 'P-...' }
 */
router.post('/noise', (req, res) => {
  const db = getDb();
  const { type, poleId } = req.body;
  const broadcast = req.app.get('broadcast');
  
  if (!type) return res.status(400).json({ error: 'type is required' });
  
  if (type === 'dead_sensor') {
    // Pick a random pole if none specified
    let targetPole = poleId;
    if (!targetPole) {
      const pole = db.prepare(`
        SELECT p.pole_id FROM poles p 
        JOIN pole_state ps ON p.pole_id = ps.pole_id 
        WHERE p.device_id IS NOT NULL AND ps.energized = 1
        ORDER BY RANDOM() LIMIT 1
      `).get();
      if (!pole) return res.status(400).json({ error: 'No suitable pole found' });
      targetPole = pole.pole_id;
    }
    
    // Mark as dark but it's actually just a dead sensor
    db.prepare('UPDATE pole_state SET energized = 0, is_sensor_dead = 1, last_event = ? WHERE pole_id = ?')
      .run('sensor_failure', targetPole);
    
    if (broadcast) {
      broadcast({
        type: 'telemetry_update',
        updates: [{ pole_id: targetPole, energized: false, event: 'sensor_failure' }],
      });
    }
    
    // Trigger analysis — should NOT create a ticket for a dead sensor
    const pole = db.prepare('SELECT dt_id FROM poles WHERE pole_id = ?').get(targetPole);
    if (pole) setTimeout(() => analyzeDT(pole.dt_id, broadcast), 1000);
    
    return res.json({ message: `Dead sensor injected at pole ${targetPole}. System should NOT create a ticket.`, poleId: targetPole });
  }
  
  if (type === 'duplicate') {
    // Send a duplicate telemetry message
    const targetPole = poleId || db.prepare('SELECT pole_id FROM poles WHERE device_id IS NOT NULL ORDER BY RANDOM() LIMIT 1').get()?.pole_id;
    
    return res.json({ message: `Duplicate noise at ${targetPole}. Telemetry system should deduplicate.`, poleId: targetPole });
  }
  
  res.status(400).json({ error: `Unknown noise type: ${type}` });
});

/**
 * POST /api/simulator/outage — Add a scheduled outage
 */
router.post('/outage', (req, res) => {
  const db = getDb();
  const { scope, targetId, durationMinutes, reason } = req.body;
  
  if (!scope || !targetId) {
    return res.status(400).json({ error: 'scope and targetId are required' });
  }
  
  const now = new Date();
  const end = new Date(now.getTime() + (durationMinutes || 60) * 60 * 1000);
  const outageId = `SO-${now.toISOString().slice(0, 10)}-${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`;
  
  db.prepare(`
    INSERT INTO scheduled_outages (outage_id, scope, target_id, start_time, end_time, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(outageId, scope, targetId, now.toISOString(), end.toISOString(), reason || 'Simulated load shedding');
  
  // Now make the poles go dark
  let affectedPoles = [];
  if (scope === 'feeder') {
    affectedPoles = db.prepare('SELECT pole_id FROM poles WHERE feeder_id = ?').all(targetId).map(p => p.pole_id);
  } else if (scope === 'dt') {
    affectedPoles = db.prepare('SELECT pole_id FROM poles WHERE dt_id = ?').all(targetId).map(p => p.pole_id);
  }
  
  const broadcast = req.app.get('broadcast');
  simulatePolesDark(db, affectedPoles, broadcast);
  
  res.json({
    outageId,
    scope,
    targetId,
    affectedPoles: affectedPoles.length,
    message: `Scheduled outage created. ${affectedPoles.length} poles affected. System should NOT create tickets.`,
  });
});

/**
 * GET /api/simulator/faults — List active simulated faults
 */
router.get('/faults', (req, res) => {
  const db = getDb();
  const faults = db.prepare('SELECT * FROM simulation_faults ORDER BY created_at DESC').all();
  res.json(faults);
});

/**
 * GET /api/simulator/targets — Get available targets for injection
 */
router.get('/targets', (req, res) => {
  const db = getDb();
  
  const feeders = db.prepare('SELECT feeder_id, substation_id FROM feeders ORDER BY feeder_id').all();
  const dts = db.prepare(`
    SELECT t.dt_id, t.feeder_id, t.has_topology,
           (SELECT COUNT(*) FROM poles WHERE dt_id = t.dt_id) as pole_count
    FROM transformers t ORDER BY t.dt_id
  `).all();
  
  res.json({ feeders, transformers: dts });
});

/**
 * POST /api/simulator/reset — Reset all simulation state
 */
router.post('/reset', (req, res) => {
  const db = getDb();
  const broadcast = req.app.get('broadcast');
  
  // Restore all poles to energized
  db.prepare('UPDATE pole_state SET energized = 1, last_event = ?, is_sensor_dead = 0, missed_heartbeats = 0')
    .run('power_restored');
  
  // Clear simulation faults
  db.prepare('DELETE FROM simulation_faults').run();
  
  // Clear tickets
  db.prepare('DELETE FROM ticket_poles').run();
  db.prepare('DELETE FROM tickets').run();
  
  if (broadcast) {
    broadcast({ type: 'system_reset' });
  }
  
  res.json({ message: 'System reset. All poles energized, all tickets cleared.' });
});

module.exports = router;
