/**
 * Telemetry Ingestion Routes
 * 
 * POST /api/telemetry — Accept device telemetry (single or batch)
 * 
 * Handles: deduplication, out-of-order messages, stale data,
 * firmware 1.2.x devices (no power_lost event), and triggers
 * fault analysis pipeline on state changes.
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/connection');
const { triggerAnalysis } = require('../core/fault-detector');

// Track heartbeat timers for firmware 1.2.x detection
const heartbeatTimers = new Map();
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000; // 3 missed heartbeats ≈ 45+ min (using shorter for demo)

/**
 * POST /api/telemetry
 * Accepts single payload or array of payloads
 */
router.post('/', (req, res) => {
  const payloads = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];
  let stateChanges = [];
  
  for (const payload of payloads) {
    const result = processPayload(payload);
    results.push(result);
    if (result.stateChanged) {
      stateChanges.push(result);
    }
  }
  
  // Trigger analysis for each pole with a state change
  const broadcast = req.app.get('broadcast');
  for (const change of stateChanges) {
    triggerAnalysis(change.poleId, broadcast);
  }
  
  // Broadcast telemetry update to connected clients
  if (broadcast && stateChanges.length > 0) {
    broadcast({
      type: 'telemetry_update',
      updates: stateChanges.map(c => ({
        pole_id: c.poleId,
        energized: c.energized,
        event: c.event,
      })),
    });
  }
  
  res.json({
    accepted: results.filter(r => r.status === 'accepted').length,
    duplicates: results.filter(r => r.status === 'duplicate').length,
    rejected: results.filter(r => r.status === 'rejected').length,
    total: results.length,
  });
});

/**
 * Process a single telemetry payload
 */
function processPayload(payload) {
  const db = getDb();
  
  const { device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw } = payload;
  
  // Validate required fields
  if (!pole_id || event === undefined) {
    return { status: 'rejected', reason: 'Missing pole_id or event' };
  }
  
  // Check if pole exists
  const pole = db.prepare('SELECT * FROM poles WHERE pole_id = ?').get(pole_id);
  if (!pole) {
    return { status: 'rejected', reason: `Unknown pole_id: ${pole_id}` };
  }
  
  // Check for duplicate via seq
  const currentState = db.prepare('SELECT * FROM pole_state WHERE pole_id = ?').get(pole_id);
  if (currentState && seq !== undefined && seq <= currentState.last_seq && event !== 'boot') {
    // Log as duplicate but don't process
    logTelemetry(db, payload, true);
    return { status: 'duplicate', poleId: pole_id };
  }
  
  // On boot, seq resets — always accept
  const isStateChange = currentState ? 
    (currentState.energized === 1) !== (energized === true) : false;
  
  // Update pole state
  const newEnergized = energized === true || energized === 1 ? 1 : 0;
  
  db.prepare(`
    INSERT INTO pole_state (pole_id, energized, last_seen, last_seq, last_event, battery_mv, rssi, missed_heartbeats, is_sensor_dead)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(pole_id) DO UPDATE SET
      energized = ?,
      last_seen = ?,
      last_seq = CASE WHEN ? = 'boot' THEN ? ELSE MAX(last_seq, ?) END,
      last_event = ?,
      battery_mv = COALESCE(?, battery_mv),
      rssi = COALESCE(?, rssi),
      missed_heartbeats = 0,
      is_sensor_dead = 0
  `).run(
    pole_id, newEnergized, ts || new Date().toISOString(), seq || 0, event, battery_mv, rssi,
    newEnergized, ts || new Date().toISOString(), event, seq || 0, seq || 0, event, battery_mv, rssi
  );
  
  // Log telemetry
  logTelemetry(db, payload, false);
  
  // Reset heartbeat timer for this device
  if (device_id) {
    resetHeartbeatTimer(pole_id, device_id, fw);
  }
  
  return {
    status: 'accepted',
    poleId: pole_id,
    event,
    energized: newEnergized === 1,
    stateChanged: isStateChange,
  };
}

/**
 * Log telemetry for debugging
 */
function logTelemetry(db, payload, isDuplicate) {
  try {
    db.prepare(`
      INSERT INTO telemetry_log (device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw, is_duplicate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.device_id, payload.pole_id, payload.event,
      payload.energized ? 1 : 0, payload.ts, payload.seq,
      payload.battery_mv, payload.rssi, payload.fw,
      isDuplicate ? 1 : 0
    );
  } catch (e) {
    // Non-critical, swallow
  }
  
  // Cleanup old telemetry (keep last hour)
  try {
    db.prepare("DELETE FROM telemetry_log WHERE received_at < datetime('now', '-1 hour')").run();
  } catch (e) { /* non-critical */ }
}

/**
 * Handle firmware 1.2.x devices that don't send power_lost.
 * Track heartbeat timing and flag as potentially dark if heartbeats stop.
 */
function resetHeartbeatTimer(poleId, deviceId, fw) {
  // Clear existing timer
  if (heartbeatTimers.has(poleId)) {
    clearTimeout(heartbeatTimers.get(poleId));
  }
  
  // Set new timer — if no heartbeat within timeout, mark as potentially dark
  heartbeatTimers.set(poleId, setTimeout(() => {
    const db = getDb();
    const state = db.prepare('SELECT * FROM pole_state WHERE pole_id = ?').get(poleId);
    if (state) {
      const missedCount = (state.missed_heartbeats || 0) + 1;
      db.prepare('UPDATE pole_state SET missed_heartbeats = ? WHERE pole_id = ?')
        .run(missedCount, poleId);
      
      // After 2 consecutive misses, consider potentially dark (especially fw 1.2.x)
      if (missedCount >= 2) {
        console.log(`[Telemetry] Pole ${poleId} missed ${missedCount} heartbeats — potential dark pole`);
      }
    }
    heartbeatTimers.delete(poleId);
  }, HEARTBEAT_TIMEOUT_MS));
}

module.exports = router;
