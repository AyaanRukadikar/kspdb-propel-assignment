/**
 * Ticket Management Routes
 */

const express = require('express');
const router = express.Router();
const { getTickets, getTicketDetail, updateTicketStatus } = require('../core/ticket-manager');

/**
 * GET /api/tickets — List tickets with optional filters
 * Query params: status, severity, dtId, feederId, activeOnly, limit
 */
router.get('/', (req, res) => {
  const filters = {
    status: req.query.status,
    severity: req.query.severity,
    dtId: req.query.dtId,
    feederId: req.query.feederId,
    activeOnly: req.query.activeOnly === 'true',
    limit: req.query.limit ? parseInt(req.query.limit) : undefined,
  };
  
  const tickets = getTickets(filters);
  res.json(tickets);
});

/**
 * GET /api/tickets/:id — Ticket detail with affected poles
 */
router.get('/:id', (req, res) => {
  const ticket = getTicketDetail(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(ticket);
});

/**
 * PATCH /api/tickets/:id — Update ticket status
 * Body: { status: 'acknowledged' | 'crew_assigned' | 'resolved' | 'closed' }
 */
router.patch('/:id', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'Status is required' });
  
  const broadcast = req.app.get('broadcast');
  const result = updateTicketStatus(req.params.id, status, broadcast);
  
  if (result.error) {
    return res.status(400).json(result);
  }
  
  res.json(result.ticket);
});

module.exports = router;
