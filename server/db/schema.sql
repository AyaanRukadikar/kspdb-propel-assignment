-- KSPDB Fault Detection System — Database Schema

-- Substations (66/11 kV)
CREATE TABLE IF NOT EXISTS substations (
  substation_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL
);

-- 11 kV Feeders
CREATE TABLE IF NOT EXISTS feeders (
  feeder_id TEXT PRIMARY KEY,
  substation_id TEXT NOT NULL,
  name TEXT,
  FOREIGN KEY (substation_id) REFERENCES substations(substation_id)
);

-- Distribution Transformers
CREATE TABLE IF NOT EXISTS transformers (
  dt_id TEXT PRIMARY KEY,
  feeder_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  capacity_kva INTEGER DEFAULT 250,
  households_served INTEGER DEFAULT 0,
  has_topology INTEGER DEFAULT 0,
  FOREIGN KEY (feeder_id) REFERENCES feeders(feeder_id)
);

-- Poles
CREATE TABLE IF NOT EXISTS poles (
  pole_id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  feeder_id TEXT NOT NULL,
  dt_id TEXT NOT NULL,
  seq_on_line INTEGER,
  parent_pole_id TEXT,
  pole_type TEXT DEFAULT 'LT-9m-PCC',
  ward TEXT,
  pincode TEXT,
  device_id TEXT,
  firmware_version TEXT DEFAULT '1.4.2',
  FOREIGN KEY (feeder_id) REFERENCES feeders(feeder_id),
  FOREIGN KEY (dt_id) REFERENCES transformers(dt_id)
);

-- Pole real-time state
CREATE TABLE IF NOT EXISTS pole_state (
  pole_id TEXT PRIMARY KEY,
  energized INTEGER DEFAULT 1,
  last_seen TEXT,
  last_seq INTEGER DEFAULT 0,
  last_event TEXT DEFAULT 'heartbeat',
  battery_mv INTEGER DEFAULT 3700,
  rssi INTEGER DEFAULT -70,
  missed_heartbeats INTEGER DEFAULT 0,
  is_sensor_dead INTEGER DEFAULT 0,
  FOREIGN KEY (pole_id) REFERENCES poles(pole_id)
);

-- Fault tickets
CREATE TABLE IF NOT EXISTS tickets (
  ticket_id TEXT PRIMARY KEY,
  fault_type TEXT NOT NULL CHECK(fault_type IN ('span','dt','feeder','unknown')),
  status TEXT NOT NULL DEFAULT 'detected' CHECK(status IN ('detected','acknowledged','crew_assigned','resolved','verified','closed')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('critical','high','medium','low')),
  confidence REAL DEFAULT 0.5,
  confidence_reason TEXT,
  
  -- Location
  fault_span_start TEXT,
  fault_span_end TEXT,
  fault_lat REAL,
  fault_lon REAL,
  pincode TEXT,
  feeder_id TEXT,
  dt_id TEXT,
  
  -- Impact
  poles_affected INTEGER DEFAULT 0,
  households_affected INTEGER DEFAULT 0,
  
  -- Topology info
  topology_source TEXT DEFAULT 'known' CHECK(topology_source IN ('known','inferred','dt_level')),
  
  -- AI summary
  summary TEXT,
  
  -- Timestamps
  detected_at TEXT NOT NULL,
  acknowledged_at TEXT,
  crew_assigned_at TEXT,
  resolved_at TEXT,
  verified_at TEXT,
  closed_at TEXT,
  updated_at TEXT,
  
  -- Suppression
  is_suppressed INTEGER DEFAULT 0,
  suppression_reason TEXT
);

-- Poles affected by each ticket
CREATE TABLE IF NOT EXISTS ticket_poles (
  ticket_id TEXT NOT NULL,
  pole_id TEXT NOT NULL,
  is_boundary INTEGER DEFAULT 0,
  PRIMARY KEY (ticket_id, pole_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id),
  FOREIGN KEY (pole_id) REFERENCES poles(pole_id)
);

-- Scheduled outages
CREATE TABLE IF NOT EXISTS scheduled_outages (
  outage_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('feeder','dt')),
  target_id TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT,
  is_active INTEGER DEFAULT 1
);

-- Telemetry log (recent only, for debugging)
CREATE TABLE IF NOT EXISTS telemetry_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  pole_id TEXT,
  event TEXT,
  energized INTEGER,
  ts TEXT,
  seq INTEGER,
  battery_mv INTEGER,
  rssi INTEGER,
  fw TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  is_duplicate INTEGER DEFAULT 0
);

-- Simulation state
CREATE TABLE IF NOT EXISTS simulation_faults (
  fault_id TEXT PRIMARY KEY,
  fault_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_label TEXT,
  span_start TEXT,
  span_end TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  is_active INTEGER DEFAULT 1
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_poles_dt ON poles(dt_id);
CREATE INDEX IF NOT EXISTS idx_poles_feeder ON poles(feeder_id);
CREATE INDEX IF NOT EXISTS idx_poles_parent ON poles(parent_pole_id);
CREATE INDEX IF NOT EXISTS idx_pole_state_energized ON pole_state(energized);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_dt ON tickets(dt_id);
CREATE INDEX IF NOT EXISTS idx_ticket_poles_ticket ON ticket_poles(ticket_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_pole ON telemetry_log(pole_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_received ON telemetry_log(received_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_outages_active ON scheduled_outages(is_active);
