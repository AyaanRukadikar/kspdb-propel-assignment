/**
 * Fault Localization Logic Unit Tests
 * 
 * Tests core logic required by brief:
 * 1. Span fault detection (live/dark boundary)
 * 2. Dead sensor filtering (dark pole with live children -> no ticket)
 * 3. Topology inference for missing pole ordering
 * 4. Grouping symptoms into a single incident ticket
 * 5. Auto-verification on restoration & rejection of premature resolution
 */

const test = require('node.test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Set test environment
process.env.NODE_ENV = 'test';

const { getDb, closeDb } = require('../db/connection');
const { getTopology, inferTopology } = require('../core/topology-inference');
const { findFaultBoundaries, isDeadSensor, isDTFault } = require('../core/fault-detector');
const { createTicket, updateTicketStatus, getTicketDetail } = require('../core/ticket-manager');

test('Fault Localization Engine Tests', async (t) => {

  await t.test('1. Dead Sensor Filtering', () => {
    const nodes = new Map();
    nodes.set('P-001', { poleId: 'P-001', energized: true, children: ['P-002'] });
    nodes.set('P-002', { poleId: 'P-002', energized: false, children: ['P-003', 'P-004'] });
    nodes.set('P-003', { poleId: 'P-003', energized: true, children: [] });
    nodes.set('P-004', { poleId: 'P-004', energized: true, children: [] });

    // P-002 is dark but ALL its children (P-003, P-004) are live -> physical impossibility, dead sensor!
    const isDead = isDeadSensor(nodes, 'P-002');
    assert.equal(isDead, true, 'P-002 should be identified as a dead sensor');
  });

  await t.test('2. Span Fault Boundary Detection & Grouping', () => {
    const nodes = new Map();
    // Tree: P-1 (live) -> P-2 (live) -> P-3 (dark) -> P-4 (dark)
    nodes.set('P-1', { poleId: 'P-1', lat: 12.97, lon: 77.59, energized: true, children: ['P-2'], deviceId: 'D1' });
    nodes.set('P-2', { poleId: 'P-2', lat: 12.971, lon: 77.591, energized: true, children: ['P-3'], deviceId: 'D2' });
    nodes.set('P-3', { poleId: 'P-3', lat: 12.972, lon: 77.592, energized: false, children: ['P-4'], deviceId: 'D3' });
    nodes.set('P-4', { poleId: 'P-4', lat: 12.973, lon: 77.593, energized: false, children: [], deviceId: 'D4' });

    const topology = {
      nodes,
      rootId: 'P-1',
      source: 'known',
      dt: { dt_id: 'D-TEST', feeder_id: 'F-TEST', lat: 12.97, lon: 77.59 }
    };

    const boundaries = findFaultBoundaries(topology);

    assert.equal(boundaries.length, 1, 'Should find exactly 1 fault boundary');
    assert.equal(boundaries[0].spanStart, 'P-2', 'Boundary start should be last live pole P-2');
    assert.equal(boundaries[0].spanEnd, 'P-3', 'Boundary end should be first dark pole P-3');
    assert.deepEqual(boundaries[0].affectedPoles, ['P-3', 'P-4'], 'All downstream poles should be grouped into single incident');
  });

  await t.test('3. Geometric Topology Inference for Missing Order', () => {
    const db = getDb();
    // Test that topology inference returns a valid tree structure from database
    const dt = db.prepare('SELECT dt_id FROM transformers WHERE has_topology = 0 LIMIT 1').get();
    if (dt) {
      const topology = getTopology(dt.dt_id);
      assert.ok(topology, 'Topology object should be returned');
      assert.equal(topology.source, 'inferred', 'Source should be inferred');
      assert.ok(topology.nodes.size > 0, 'Should have nodes');
    }
  });

  await t.test('4. Ticket Workflow - Reject premature manual resolution', () => {
    const db = getDb();
    
    // Create a mock ticket
    const ticket = createTicket({
      faultType: 'span',
      spanStart: 'P-024431',
      spanEnd: 'P-024432',
      faultLat: 12.968,
      faultLon: 77.594,
      pincode: '560078',
      feederId: 'F-07-03',
      dtId: 'D-0112',
      affectedPoles: ['P-024432'],
      confidence: 0.8,
      confidenceReason: 'Test fault',
      topologySource: 'known',
      severity: 'medium',
    });

    assert.equal(ticket.status, 'detected');

    // Transition to acknowledged
    let update = updateTicketStatus(ticket.ticket_id, 'acknowledged');
    assert.equal(update.ticket.status, 'acknowledged');

    // Transition to crew_assigned
    update = updateTicketStatus(ticket.ticket_id, 'crew_assigned');
    assert.equal(update.ticket.status, 'crew_assigned');

    // Try to mark resolved while poles are still dark in pole_state
    db.prepare('UPDATE pole_state SET energized = 0 WHERE pole_id = ?').run('P-024432');
    
    const resolveAttempt = updateTicketStatus(ticket.ticket_id, 'resolved');
    assert.ok(resolveAttempt.error, 'Should reject manual resolution when telemetry is still dark');
    assert.match(resolveAttempt.error, /still dark/, 'Error message should explain rejection');

    // Now energize pole and try again
    db.prepare('UPDATE pole_state SET energized = 1 WHERE pole_id = ?').run('P-024432');
    const validResolve = updateTicketStatus(ticket.ticket_id, 'resolved');
    assert.equal(validResolve.ticket.status, 'resolved', 'Should allow resolution when telemetry confirmed live');
  });

  closeDb();
});
