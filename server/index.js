/**
 * KSPDB Fault Detection System — Server Entry Point
 * 
 * Express server with WebSocket support for real-time operator console updates.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { getDb, closeDb } = require('./db/connection');

const app = express();
const server = http.createServer(app);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (${clients.size} total)`);
  });
  
  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    clients.delete(ws);
  });
});

// Broadcast function for real-time updates
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(data);
    }
  }
}

app.set('broadcast', broadcast);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/telemetry', require('./routes/telemetry'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/network', require('./routes/network'));
app.use('/api/simulator', require('./routes/simulator'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    name: 'KSPDB Fault Detection System',
  });
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Initialize database
try {
  getDb();
  console.log('✅ Database connected');
} catch (err) {
  console.error('❌ Database initialization failed:', err.message);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log('');
  console.log('━'.repeat(55));
  console.log('  ⚡ KSPDB Fault Detection System');
  console.log('━'.repeat(55));
  console.log(`  🌐 Server:     http://localhost:${PORT}`);
  console.log(`  📡 WebSocket:  ws://localhost:${PORT}/ws`);
  console.log(`  📊 API:        http://localhost:${PORT}/api/health`);
  console.log('━'.repeat(55));
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  closeDb();
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  closeDb();
  server.close();
  process.exit(0);
});
