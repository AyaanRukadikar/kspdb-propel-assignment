/**
 * KSPDB Operator Console — Main Application
 * 
 * Single-file frontend application managing:
 * - WebSocket connection for real-time updates
 * - Leaflet map with pole markers
 * - Ticket list and detail view
 * - Fault simulator controls
 * - Toast notifications
 */

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════
const state = {
  ws: null,
  map: null,
  poles: [],
  markers: {},        // pole_id → Leaflet marker
  dtMarkers: {},      // dt_id → marker
  faultLines: [],     // Leaflet polylines for fault boundaries
  tickets: [],
  selectedTicket: null,
  simTargets: null,
  stats: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initClock();
  initEventListeners();
  connectWebSocket();
  loadInitialData();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Map
// ═══════════════════════════════════════════════════════════════════════════════
function initMap() {
  // Bangalore center
  state.map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
  }).setView([12.9600, 77.5800], 13);
  
  // Dark map tiles (CartoDB Dark Matter)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(state.map);
}

async function loadPoles() {
  try {
    const res = await fetch('/api/network/poles');
    state.poles = await res.json();
    renderPoleMarkers();
    fitMapToPoles();
  } catch (err) {
    console.error('Failed to load poles:', err);
  }
}

function renderPoleMarkers() {
  // Clear existing markers
  Object.values(state.markers).forEach(m => m.remove());
  state.markers = {};
  
  for (const pole of state.poles) {
    const color = getPoleColor(pole);
    const radius = pole.energized === 0 ? 5 : 3;
    
    const marker = L.circleMarker([pole.lat, pole.lon], {
      radius,
      fillColor: color,
      fillOpacity: pole.energized === 0 ? 0.9 : 0.6,
      stroke: pole.energized === 0,
      color: pole.energized === 0 ? color : 'transparent',
      weight: pole.energized === 0 ? 2 : 0,
      className: pole.energized === 0 ? 'dark-pole-marker' : '',
    }).addTo(state.map);
    
    marker.bindPopup(() => createPolePopup(pole));
    marker.on('click', () => {
      // Highlight this pole's DT
    });
    
    state.markers[pole.pole_id] = marker;
  }
}

function getPoleColor(pole) {
  if (!pole.device_id) return '#6b7280'; // No device — grey
  if (pole.is_sensor_dead) return '#f59e0b'; // Dead sensor — amber
  if (pole.energized === 0) return '#ef4444'; // Dark — red
  return '#22c55e'; // Live — green
}

function createPolePopup(pole) {
  const status = !pole.device_id ? '⬛ No Device' :
                 pole.is_sensor_dead ? '🟡 Sensor Dead' :
                 pole.energized === 0 ? '🔴 Dark' : '🟢 Energized';
  
  return `
    <div style="min-width: 180px;">
      <div style="font-weight: 700; font-size: 14px; margin-bottom: 6px;">${pole.pole_id}</div>
      <div style="margin-bottom: 4px;">${status}</div>
      <div style="font-size: 11px; color: #94a3b8;">
        <div>DT: ${pole.dt_id} · Feeder: ${pole.feeder_id}</div>
        <div>Ward: ${pole.ward || '—'} · PIN: ${pole.pincode || '—'}</div>
        <div>Device: ${pole.device_id || 'None'}</div>
        ${pole.last_seen ? `<div>Last seen: ${formatTime(pole.last_seen)}</div>` : ''}
        <div>Coords: ${pole.lat.toFixed(6)}, ${pole.lon.toFixed(6)}</div>
      </div>
    </div>
  `;
}

function fitMapToPoles() {
  if (state.poles.length === 0) return;
  const bounds = L.latLngBounds(state.poles.map(p => [p.lat, p.lon]));
  state.map.fitBounds(bounds, { padding: [40, 40] });
}

function updatePoleMarker(poleId, energized) {
  const marker = state.markers[poleId];
  if (!marker) return;
  
  const color = energized ? '#22c55e' : '#ef4444';
  marker.setStyle({
    fillColor: color,
    fillOpacity: energized ? 0.6 : 0.9,
    radius: energized ? 3 : 5,
    stroke: !energized,
    color: !energized ? color : 'transparent',
    weight: !energized ? 2 : 0,
  });
  
  // Update local state
  const pole = state.poles.find(p => p.pole_id === poleId);
  if (pole) pole.energized = energized ? 1 : 0;
}

function highlightTicketOnMap(ticket) {
  // Clear previous highlights
  clearFaultHighlights();
  
  if (!ticket) return;
  
  // Zoom to fault location
  if (ticket.fault_lat && ticket.fault_lon) {
    state.map.flyTo([ticket.fault_lat, ticket.fault_lon], 16, { duration: 1 });
  }
  
  // Draw fault boundary line
  if (ticket.fault_span_start && ticket.fault_span_end) {
    const startPole = state.poles.find(p => p.pole_id === ticket.fault_span_start);
    const endPole = state.poles.find(p => p.pole_id === ticket.fault_span_end);
    
    if (startPole && endPole) {
      const faultLine = L.polyline(
        [[startPole.lat, startPole.lon], [endPole.lat, endPole.lon]],
        {
          color: '#f59e0b',
          weight: 4,
          opacity: 0.9,
          dashArray: '8, 8',
          className: 'fault-line-animated',
        }
      ).addTo(state.map);
      
      state.faultLines.push(faultLine);
      
      // Add fault marker at midpoint
      const faultMarker = L.marker([ticket.fault_lat, ticket.fault_lon], {
        icon: L.divIcon({
          className: 'fault-icon',
          html: '<div style="background: #f59e0b; width: 14px; height: 14px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 16px rgba(245,158,11,0.6);"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
      }).addTo(state.map);
      
      state.faultLines.push(faultMarker);
    }
  }
  
  // Highlight affected poles
  if (ticket.poles) {
    for (const pole of ticket.poles) {
      const marker = state.markers[pole.pole_id];
      if (marker) {
        marker.setStyle({
          fillColor: pole.is_boundary ? '#f59e0b' : '#ef4444',
          fillOpacity: 1,
          radius: pole.is_boundary ? 8 : 5,
          stroke: true,
          color: pole.is_boundary ? '#fff' : '#ef4444',
          weight: pole.is_boundary ? 2 : 1,
        });
      }
    }
  }
}

function clearFaultHighlights() {
  state.faultLines.forEach(l => l.remove());
  state.faultLines = [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// WebSocket
// ═══════════════════════════════════════════════════════════════════════════════
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws`;
  
  try {
    state.ws = new WebSocket(url);
    
    state.ws.onopen = () => {
      state.reconnectAttempts = 0;
      updateConnectionStatus('connected');
      console.log('[WS] Connected');
    };
    
    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };
    
    state.ws.onclose = () => {
      updateConnectionStatus('disconnected');
      scheduleReconnect();
    };
    
    state.ws.onerror = () => {
      updateConnectionStatus('error');
    };
  } catch (e) {
    console.error('[WS] Connection failed:', e);
    updateConnectionStatus('error');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 30000);
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(connectWebSocket, delay);
}

function updateConnectionStatus(status) {
  const el = document.getElementById('status-connection');
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('span:last-child');
  
  dot.className = 'status-dot';
  
  switch (status) {
    case 'connected':
      dot.classList.add('dot-ok');
      text.textContent = 'Live';
      break;
    case 'disconnected':
      dot.classList.add('dot-warning');
      text.textContent = 'Reconnecting...';
      break;
    case 'error':
      dot.classList.add('dot-error');
      text.textContent = 'Offline';
      break;
    default:
      dot.classList.add('dot-connecting');
      text.textContent = 'Connecting...';
  }
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'telemetry_update':
      handleTelemetryUpdate(msg.updates);
      break;
    case 'ticket_created':
      handleTicketCreated(msg.ticket);
      break;
    case 'ticket_updated':
      handleTicketUpdated(msg.ticket);
      break;
    case 'system_reset':
      handleSystemReset();
      break;
  }
}

function handleTelemetryUpdate(updates) {
  if (!updates) return;
  
  let darkCount = 0;
  for (const update of updates) {
    updatePoleMarker(update.pole_id, update.energized);
    if (!update.energized) darkCount++;
  }
  
  // Update stats
  updateStats();
}

function handleTicketCreated(ticket) {
  if (!ticket) return;
  
  // Add to local state
  state.tickets.unshift(ticket);
  renderTicketList();
  updateStats();
  
  // Show toast
  const severity = ticket.severity || 'medium';
  showToast(`⚡ New ${severity.toUpperCase()} fault detected: ${getFaultLabel(ticket)}`, 'fault');
  
  // Highlight on map
  highlightTicketOnMap(ticket);
}

function handleTicketUpdated(ticket) {
  if (!ticket) return;
  
  const idx = state.tickets.findIndex(t => t.ticket_id === ticket.ticket_id);
  if (idx >= 0) {
    state.tickets[idx] = ticket;
  }
  
  renderTicketList();
  
  if (state.selectedTicket?.ticket_id === ticket.ticket_id) {
    showTicketDetail(ticket.ticket_id);
  }
  
  if (ticket.status === 'verified') {
    showToast(`✅ Ticket ${ticket.ticket_id} auto-verified — power restored!`, 'success');
  }
  
  updateStats();
}

function handleSystemReset() {
  state.tickets = [];
  renderTicketList();
  loadPoles();
  updateStats();
  clearFaultHighlights();
  loadSimulatorFaults();
  
  if (document.getElementById('detail-view')) {
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('simulator-panel').classList.remove('hidden');
  }
  
  showToast('🔄 System reset — all systems operational', 'info');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Data Loading
// ═══════════════════════════════════════════════════════════════════════════════
async function loadInitialData() {
  await Promise.all([
    loadPoles(),
    loadTickets(),
    loadStats(),
    loadSimulatorTargets(),
    loadSimulatorFaults(),
  ]);
}

async function loadTickets() {
  try {
    const res = await fetch('/api/tickets?limit=100');
    state.tickets = await res.json();
    renderTicketList();
  } catch (err) {
    console.error('Failed to load tickets:', err);
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/network/stats');
    state.stats = await res.json();
    updateStatsDisplay();
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function updateStats() {
  await loadStats();
}

function updateStatsDisplay() {
  if (!state.stats) return;
  
  document.getElementById('stat-poles-live').textContent = state.stats.polesEnergized?.toLocaleString() || '--';
  document.getElementById('stat-poles-dark').textContent = state.stats.polesDark || '0';
  document.getElementById('stat-active-tickets').textContent = state.stats.activeTickets || '0';
  
  // Update dark indicator
  const darkChip = document.getElementById('status-dark');
  const dot = darkChip.querySelector('.status-dot');
  if (state.stats.polesDark > 0) {
    dot.className = 'status-dot dot-error';
  } else {
    dot.className = 'status-dot dot-ok';
  }
  
  // Update ticket alert
  const ticketChip = document.getElementById('status-tickets');
  if (state.stats.activeTickets > 0) {
    ticketChip.classList.add('status-chip-alert');
  } else {
    ticketChip.classList.remove('status-chip-alert');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ticket List
// ═══════════════════════════════════════════════════════════════════════════════
function renderTicketList() {
  const container = document.getElementById('ticket-list');
  const filter = document.getElementById('filter-status').value;
  
  let tickets = state.tickets;
  if (filter === 'active') {
    tickets = tickets.filter(t => !['verified', 'closed'].includes(t.status));
  } else if (filter !== 'all') {
    tickets = tickets.filter(t => t.status === filter);
  }
  
  if (tickets.length === 0) {
    container.innerHTML = `
      <div class="empty-state" id="empty-tickets">
        <span class="empty-icon">✅</span>
        <p>No ${filter === 'all' ? '' : filter} incidents</p>
        <small>Use the simulator to inject a fault</small>
      </div>
    `;
    return;
  }
  
  container.innerHTML = tickets.map(ticket => `
    <div class="ticket-card ${state.selectedTicket?.ticket_id === ticket.ticket_id ? 'active' : ''}" 
         data-severity="${ticket.severity}"
         data-id="${ticket.ticket_id}"
         onclick="selectTicket('${ticket.ticket_id}')">
      <div class="ticket-card-header">
        <span class="ticket-id">${ticket.ticket_id}</span>
        <span class="ticket-severity severity-${ticket.severity}">${ticket.severity}</span>
      </div>
      <div class="ticket-type">${getFaultLabel(ticket)}</div>
      <div class="ticket-location">
        ${ticket.pincode ? `PIN ${ticket.pincode}` : ''}
        ${ticket.dt_id ? ` · DT ${ticket.dt_id}` : ''}
        ${ticket.feeder_id ? ` · ${ticket.feeder_id}` : ''}
      </div>
      <div class="ticket-meta">
        <div class="ticket-badges">
          <span class="badge badge-poles">🔴 ${ticket.poles_affected} poles</span>
          <span class="badge badge-confidence">${Math.round(ticket.confidence * 100)}%</span>
        </div>
        <span class="badge-status status-${ticket.status}">${formatStatus(ticket.status)}</span>
      </div>
      <div class="ticket-meta" style="margin-top: 4px;">
        <span>${formatTimeAgo(ticket.detected_at)}</span>
        <span>${ticket.households_affected || 0} households</span>
      </div>
    </div>
  `).join('');
}

function getFaultLabel(ticket) {
  switch (ticket.fault_type) {
    case 'span': return `Span Fault: ${ticket.fault_span_start} → ${ticket.fault_span_end}`;
    case 'dt': return `DT Fault: ${ticket.dt_id}`;
    case 'feeder': return `Feeder Fault: ${ticket.feeder_id}`;
    default: return 'Unknown Fault';
  }
}

function formatStatus(status) {
  return status.replace(/_/g, ' ');
}

function selectTicket(ticketId) {
  showTicketDetail(ticketId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Ticket Detail
// ═══════════════════════════════════════════════════════════════════════════════
async function showTicketDetail(ticketId) {
  try {
    const res = await fetch(`/api/tickets/${ticketId}`);
    const ticket = await res.json();
    
    state.selectedTicket = ticket;
    
    // Show detail panel, hide simulator
    document.getElementById('detail-view').classList.remove('hidden');
    document.getElementById('simulator-panel').classList.add('hidden');
    
    // Update header
    document.getElementById('detail-ticket-id').textContent = ticket.ticket_id;
    
    // Render detail content
    const content = document.getElementById('detail-content');
    content.innerHTML = renderTicketDetail(ticket);
    
    // Highlight on map
    highlightTicketOnMap(ticket);
    
    // Re-render ticket list to show active state
    renderTicketList();
    
  } catch (err) {
    console.error('Failed to load ticket detail:', err);
  }
}

function renderTicketDetail(ticket) {
  const confidenceColor = ticket.confidence >= 0.7 ? '#22c55e' : 
                           ticket.confidence >= 0.4 ? '#f59e0b' : '#ef4444';
  
  const topologyLabel = {
    known: '✅ Known Topology',
    inferred: '⚠️ Inferred from GPS',
    dt_level: '📍 DT-Level Only',
  }[ticket.topology_source] || ticket.topology_source;
  
  let html = `
    <!-- Status & Severity -->
    <div class="detail-section">
      <div style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
        <span class="badge-status status-${ticket.status}" style="font-size: 12px; padding: 4px 12px;">${formatStatus(ticket.status)}</span>
        <span class="ticket-severity severity-${ticket.severity}" style="font-size: 11px;">${ticket.severity.toUpperCase()}</span>
        <span class="topology-badge topology-${ticket.topology_source}">${topologyLabel}</span>
      </div>
    </div>
    
    <!-- Summary -->
    <div class="detail-section">
      <h3>Summary</h3>
      <div class="detail-summary">${ticket.summary || 'No summary available.'}</div>
    </div>
    
    <!-- Location -->
    <div class="detail-section">
      <h3>Location</h3>
      <div class="detail-row"><span class="detail-label">Fault Type</span><span class="detail-value">${ticket.fault_type}</span></div>
      ${ticket.fault_span_start ? `<div class="detail-row"><span class="detail-label">Span</span><span class="detail-value">${ticket.fault_span_start} → ${ticket.fault_span_end}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Coordinates</span><span class="detail-value">${ticket.fault_lat?.toFixed(6)}, ${ticket.fault_lon?.toFixed(6)}</span></div>
      <div class="detail-row"><span class="detail-label">PIN Code</span><span class="detail-value">${ticket.pincode || '—'}</span></div>
      ${ticket.dt_id ? `<div class="detail-row"><span class="detail-label">Transformer</span><span class="detail-value">${ticket.dt_id}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Feeder</span><span class="detail-value">${ticket.feeder_id || '—'}</span></div>
    </div>
    
    <!-- Impact -->
    <div class="detail-section">
      <h3>Impact</h3>
      <div class="detail-row"><span class="detail-label">Poles Affected</span><span class="detail-value" style="color: #ef4444; font-weight: 700;">${ticket.poles_affected}</span></div>
      <div class="detail-row"><span class="detail-label">Households</span><span class="detail-value">~${ticket.households_affected?.toLocaleString()}</span></div>
    </div>
    
    <!-- Confidence -->
    <div class="detail-section">
      <h3>Confidence</h3>
      <div class="detail-row">
        <span class="detail-label">Score</span>
        <span class="detail-value" style="color: ${confidenceColor}; font-weight: 700;">${Math.round(ticket.confidence * 100)}%</span>
      </div>
      <div class="confidence-bar">
        <div class="confidence-fill" style="width: ${ticket.confidence * 100}%; background: ${confidenceColor};"></div>
      </div>
      <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">${ticket.confidence_reason || ''}</div>
    </div>
    
    <!-- Timeline -->
    <div class="detail-section">
      <h3>Timeline</h3>
      <div class="timeline">
        ${renderTimeline(ticket)}
      </div>
    </div>
    
    <!-- Actions -->
    <div class="detail-section">
      <h3>Actions</h3>
      <div class="detail-actions">
        ${renderActions(ticket)}
      </div>
    </div>
  `;
  
  return html;
}

function renderTimeline(ticket) {
  const stages = [
    { key: 'detected', label: 'Detected', time: ticket.detected_at },
    { key: 'acknowledged', label: 'Acknowledged', time: ticket.acknowledged_at },
    { key: 'crew_assigned', label: 'Crew Assigned', time: ticket.crew_assigned_at },
    { key: 'resolved', label: 'Resolved', time: ticket.resolved_at },
    { key: 'verified', label: 'Verified', time: ticket.verified_at },
    { key: 'closed', label: 'Closed', time: ticket.closed_at },
  ];
  
  let reachedCurrent = false;
  
  return stages.map(stage => {
    const isCompleted = !!stage.time;
    const isCurrent = stage.key === ticket.status;
    
    if (isCurrent) reachedCurrent = true;
    
    const cls = isCompleted ? 'completed' : (isCurrent ? 'active' : '');
    
    return `
      <div class="timeline-item ${cls}">
        <span class="timeline-label">${stage.label}</span>
        ${stage.time ? `<span class="timeline-time">${formatTime(stage.time)}</span>` : ''}
      </div>
    `;
  }).join('');
}

function renderActions(ticket) {
  const transitions = {
    detected: [{ status: 'acknowledged', label: 'Acknowledge', cls: 'btn-primary' }],
    acknowledged: [{ status: 'crew_assigned', label: 'Assign Crew', cls: 'btn-primary' }],
    crew_assigned: [{ status: 'resolved', label: 'Mark Resolved', cls: 'btn-warning' }],
    resolved: [],
    verified: [{ status: 'closed', label: 'Close Ticket', cls: 'btn-success' }],
    closed: [],
  };
  
  const actions = transitions[ticket.status] || [];
  
  return actions.map(action => `
    <button class="btn ${action.cls}" onclick="updateTicket('${ticket.ticket_id}', '${action.status}')">
      ${action.label}
    </button>
  `).join('') || '<span style="color: var(--text-muted); font-size: 12px;">Awaiting telemetry verification...</span>';
}

async function updateTicket(ticketId, newStatus) {
  try {
    const res = await fetch(`/api/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      showToast(`❌ ${data.error}`, 'warning');
      return;
    }
    
    showToast(`✅ Ticket updated to: ${formatStatus(newStatus)}`, 'success');
    showTicketDetail(ticketId);
    loadTickets();
    
  } catch (err) {
    showToast(`❌ Failed to update ticket: ${err.message}`, 'warning');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Simulator
// ═══════════════════════════════════════════════════════════════════════════════
async function loadSimulatorTargets() {
  try {
    const res = await fetch('/api/simulator/targets');
    state.simTargets = await res.json();
    updateSimulatorDropdowns();
  } catch (err) {
    console.error('Failed to load simulator targets:', err);
  }
}

function updateSimulatorDropdowns() {
  if (!state.simTargets) return;
  
  updateFaultTargetDropdown();
  updateOutageTargetDropdown();
}

function updateFaultTargetDropdown() {
  const typeSelect = document.getElementById('sim-fault-type');
  const targetSelect = document.getElementById('sim-target');
  const type = typeSelect.value;
  
  targetSelect.innerHTML = '';
  
  if (type === 'span' || type === 'dt') {
    state.simTargets.transformers.forEach(dt => {
      const topo = dt.has_topology ? '✅' : '⚠️';
      const opt = document.createElement('option');
      opt.value = dt.dt_id;
      opt.textContent = `${topo} ${dt.dt_id} (${dt.pole_count} poles, ${dt.feeder_id})`;
      targetSelect.appendChild(opt);
    });
  } else if (type === 'feeder') {
    state.simTargets.feeders.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.feeder_id;
      opt.textContent = `${f.feeder_id} (${f.substation_id})`;
      targetSelect.appendChild(opt);
    });
  }
}

function updateOutageTargetDropdown() {
  const scope = document.getElementById('sim-outage-scope').value;
  const targetSelect = document.getElementById('sim-outage-target');
  
  targetSelect.innerHTML = '';
  
  if (scope === 'dt') {
    state.simTargets.transformers.slice(0, 30).forEach(dt => {
      const opt = document.createElement('option');
      opt.value = dt.dt_id;
      opt.textContent = `${dt.dt_id} (${dt.pole_count} poles)`;
      targetSelect.appendChild(opt);
    });
  } else {
    state.simTargets.feeders.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.feeder_id;
      opt.textContent = f.feeder_id;
      targetSelect.appendChild(opt);
    });
  }
}

async function injectFault() {
  const type = document.getElementById('sim-fault-type').value;
  const targetId = document.getElementById('sim-target').value;
  
  if (!targetId) {
    showToast('⚠️ Please select a target', 'warning');
    return;
  }
  
  try {
    const res = await fetch('/api/simulator/fault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, targetId }),
    });
    
    const data = await res.json();
    
    if (res.ok) {
      showToast(`⚡ ${data.message}`, 'fault');
      loadSimulatorFaults();
    } else {
      showToast(`❌ ${data.error}`, 'warning');
    }
  } catch (err) {
    showToast(`❌ Injection failed: ${err.message}`, 'warning');
  }
}

async function repairFault(faultId) {
  try {
    const res = await fetch('/api/simulator/repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faultId }),
    });
    
    const data = await res.json();
    
    if (res.ok) {
      showToast(`🔧 ${data.message}`, 'success');
      loadSimulatorFaults();
      loadPoles();
    } else {
      showToast(`❌ ${data.error}`, 'warning');
    }
  } catch (err) {
    showToast(`❌ Repair failed: ${err.message}`, 'warning');
  }
}

async function injectDeadSensor() {
  try {
    const res = await fetch('/api/simulator/noise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'dead_sensor' }),
    });
    
    const data = await res.json();
    showToast(`📡 ${data.message}`, 'info');
    
  } catch (err) {
    showToast(`❌ Failed: ${err.message}`, 'warning');
  }
}

async function scheduleOutage() {
  const scope = document.getElementById('sim-outage-scope').value;
  const targetId = document.getElementById('sim-outage-target').value;
  
  if (!targetId) {
    showToast('⚠️ Select a target', 'warning');
    return;
  }
  
  try {
    const res = await fetch('/api/simulator/outage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, targetId, durationMinutes: 60, reason: 'Simulated load shedding' }),
    });
    
    const data = await res.json();
    showToast(`📅 ${data.message}`, 'info');
    loadPoles();
    
  } catch (err) {
    showToast(`❌ Failed: ${err.message}`, 'warning');
  }
}

async function resetSimulation() {
  try {
    const res = await fetch('/api/simulator/reset', {
      method: 'POST',
    });
    
    const data = await res.json();
    showToast(`🔄 ${data.message}`, 'info');
    
  } catch (err) {
    showToast(`❌ Reset failed: ${err.message}`, 'warning');
  }
}

async function loadSimulatorFaults() {
  try {
    const res = await fetch('/api/simulator/faults');
    const faults = await res.json();
    
    const container = document.getElementById('sim-active-faults');
    const activeFaults = faults.filter(f => f.is_active);
    
    if (activeFaults.length === 0) {
      container.innerHTML = '<div class="empty-state-mini">No active simulated faults</div>';
      return;
    }
    
    container.innerHTML = activeFaults.map(f => `
      <div class="sim-fault-item">
        <span class="sim-fault-label">${f.target_label || f.fault_id}</span>
        <button class="btn-repair" onclick="repairFault('${f.fault_id}')">🔧 Repair</button>
      </div>
    `).join('');
    
  } catch (err) {
    console.error('Failed to load simulator faults:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════════════════════
function initEventListeners() {
  // Simulator toggle
  document.getElementById('btn-toggle-simulator').addEventListener('click', () => {
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('simulator-panel').classList.remove('hidden');
    state.selectedTicket = null;
    clearFaultHighlights();
    renderTicketList();
  });
  
  // Close detail
  document.getElementById('btn-close-detail').addEventListener('click', () => {
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('simulator-panel').classList.remove('hidden');
    state.selectedTicket = null;
    clearFaultHighlights();
    renderTicketList();
  });
  
  // Filter
  document.getElementById('filter-status').addEventListener('change', renderTicketList);
  
  // Simulator actions
  document.getElementById('btn-inject-fault').addEventListener('click', injectFault);
  document.getElementById('btn-dead-sensor').addEventListener('click', injectDeadSensor);
  document.getElementById('btn-schedule-outage').addEventListener('click', scheduleOutage);
  document.getElementById('btn-reset-sim').addEventListener('click', resetSimulation);
  
  // Fault type change → update targets
  document.getElementById('sim-fault-type').addEventListener('change', updateFaultTargetDropdown);
  document.getElementById('sim-outage-scope').addEventListener('change', updateOutageTargetDropdown);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Clock
// ═══════════════════════════════════════════════════════════════════════════════
function initClock() {
  function tick() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }
  tick();
  setInterval(tick, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Toast Notifications
// ═══════════════════════════════════════════════════════════════════════════════
function showToast(message, type = 'info', duration = 5000) {
  const container = document.getElementById('toast-container');
  
  const icons = {
    fault: '⚡',
    success: '✅',
    warning: '⚠️',
    info: 'ℹ️',
  };
  
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
    <span class="toast-message">${message}</span>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════
function formatTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) +
         ' ' + d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function formatTimeAgo(isoStr) {
  if (!isoStr) return '';
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diff = now - then;
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}
