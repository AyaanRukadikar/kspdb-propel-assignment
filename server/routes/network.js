/**
 * Network Data Routes
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/connection');
const { getTopology } = require('../core/topology-inference');

/**
 * GET /api/network/stats — System overview stats
 */
router.get('/stats', (req, res) => {
  const db = getDb();
  
  const stats = {
    substations: db.prepare('SELECT COUNT(*) as c FROM substations').get().c,
    feeders: db.prepare('SELECT COUNT(*) as c FROM feeders').get().c,
    transformers: db.prepare('SELECT COUNT(*) as c FROM transformers').get().c,
    poles: db.prepare('SELECT COUNT(*) as c FROM poles').get().c,
    polesWithDevice: db.prepare('SELECT COUNT(*) as c FROM poles WHERE device_id IS NOT NULL').get().c,
    polesEnergized: db.prepare('SELECT COUNT(*) as c FROM pole_state WHERE energized = 1').get().c,
    polesDark: db.prepare('SELECT COUNT(*) as c FROM pole_state WHERE energized = 0').get().c,
    activeTickets: db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status NOT IN ('verified', 'closed')").get().c,
    totalTickets: db.prepare('SELECT COUNT(*) as c FROM tickets').get().c,
    dtsWithTopology: db.prepare('SELECT COUNT(*) as c FROM transformers WHERE has_topology = 1').get().c,
  };
  
  res.json(stats);
});

/**
 * GET /api/network/poles — All poles with current state
 * Query: dtId, feederId, limit, offset
 */
router.get('/poles', (req, res) => {
  const db = getDb();
  let query = `
    SELECT p.*, ps.energized, ps.last_seen, ps.last_event, ps.missed_heartbeats, ps.is_sensor_dead
    FROM poles p
    LEFT JOIN pole_state ps ON p.pole_id = ps.pole_id
    WHERE 1=1
  `;
  const params = [];
  
  if (req.query.dtId) {
    query += ' AND p.dt_id = ?';
    params.push(req.query.dtId);
  }
  if (req.query.feederId) {
    query += ' AND p.feeder_id = ?';
    params.push(req.query.feederId);
  }
  
  query += ' ORDER BY p.dt_id, p.seq_on_line';
  
  if (req.query.limit) {
    query += ' LIMIT ?';
    params.push(parseInt(req.query.limit));
  }
  if (req.query.offset) {
    query += ' OFFSET ?';
    params.push(parseInt(req.query.offset));
  }
  
  const poles = db.prepare(query).all(...params);
  res.json(poles);
});

/**
 * GET /api/network/transformers — All distribution transformers
 */
router.get('/transformers', (req, res) => {
  const db = getDb();
  
  let query = `
    SELECT t.*, 
           (SELECT COUNT(*) FROM poles p WHERE p.dt_id = t.dt_id) as pole_count,
           (SELECT COUNT(*) FROM poles p JOIN pole_state ps ON p.pole_id = ps.pole_id WHERE p.dt_id = t.dt_id AND ps.energized = 0) as dark_count
    FROM transformers t
  `;
  const params = [];
  
  if (req.query.feederId) {
    query += ' WHERE t.feeder_id = ?';
    params.push(req.query.feederId);
  }
  
  query += ' ORDER BY t.dt_id';
  
  const dts = db.prepare(query).all(...params);
  res.json(dts);
});

/**
 * GET /api/network/feeders — All feeders
 */
router.get('/feeders', (req, res) => {
  const db = getDb();
  const feeders = db.prepare(`
    SELECT f.*, s.name as substation_name,
           (SELECT COUNT(*) FROM transformers t WHERE t.feeder_id = f.feeder_id) as dt_count
    FROM feeders f
    JOIN substations s ON f.substation_id = s.substation_id
    ORDER BY f.feeder_id
  `).all();
  res.json(feeders);
});

/**
 * GET /api/network/topology/:dtId — Get tree topology for a DT
 */
router.get('/topology/:dtId', (req, res) => {
  const topology = getTopology(req.params.dtId);
  if (!topology) return res.status(404).json({ error: 'DT not found' });
  
  // Convert Map to array for JSON serialization
  const nodes = [];
  for (const [id, node] of topology.nodes) {
    nodes.push(node);
  }
  
  res.json({
    dtId: req.params.dtId,
    rootId: topology.rootId,
    source: topology.source,
    dt: topology.dt,
    nodes,
  });
});

/**
 * GET /api/scheduled-outages — Mock scheduled outage feed
 */
router.get('/scheduled-outages', (req, res) => {
  const db = getDb();
  const outages = db.prepare('SELECT * FROM scheduled_outages ORDER BY start_time DESC').all();
  res.json(outages);
});

module.exports = router;
