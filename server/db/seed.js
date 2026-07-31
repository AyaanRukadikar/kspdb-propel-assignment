/**
 * KSPDB Seed Data Generator
 * 
 * Generates a realistic synthetic power distribution network modelled on
 * Bangalore's layout. Creates substations, feeders, distribution transformers,
 * and poles with coordinates, topology (40% complete, 60% missing), and
 * device assignments (~91% coverage).
 */

const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const Database = require('better-sqlite3');
const dbPath = path.join(dataDir, 'kspdb.db');

// Remove existing DB for clean seed
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Load and execute schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  substations: 4,
  feedersPerSubstation: [7, 8, 8, 8],    // total = 31
  dtsPerFeeder: { min: 10, max: 16 },     // ~412 total
  polesPerDT: { min: 15, max: 120 },      // median ~70
  branchProbability: 0.25,                 // chance of a branch spur
  branchLength: { min: 3, max: 12 },
  topologyKnownPercent: 0.40,              // 40% of DTs have known topology
  deviceCoverage: 0.91,                    // 91% of poles have devices
  firmwareOldPercent: 0.08,                // 8% on fw 1.2.x
  missingPincodePercent: 0.03,             // 3% missing pincode
};

// Bangalore-area center coordinates with slight offsets per substation
const SUBSTATION_CENTERS = [
  { lat: 12.9716, lon: 77.5946, name: 'Jayanagar 66kV' },
  { lat: 12.9352, lon: 77.6245, name: 'Koramangala 66kV' },
  { lat: 12.9850, lon: 77.5533, name: 'Rajajinagar 66kV' },
  { lat: 12.9550, lon: 77.5870, name: 'Basavanagudi 66kV' },
];

const POLE_TYPES = ['LT-9m-PCC', 'LT-9m-PCC', 'LT-9m-PCC', 'LT-8m-Steel', 'LT-11m-PCC', 'LT-8m-Steel'];
const WARDS = [];
for (let i = 1; i <= 120; i++) WARDS.push(`W-${String(i).padStart(3, '0')}`);
const PINCODES = ['560004', '560011', '560018', '560019', '560025', '560027', '560028', '560029', '560034', '560041', '560050', '560069', '560070', '560076', '560078', '560085', '560095', '560096'];

// ── Helpers ───────────────────────────────────────────────────────────────────
let poleCounter = 1;
let dtCounter = 1;
let feederCounter = 1;
let deviceCounter = 1;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Generate a random direction in radians, with optional bias
function randomAngle(bias, spread) {
  if (bias !== undefined) {
    return bias + (Math.random() - 0.5) * spread;
  }
  return Math.random() * 2 * Math.PI;
}

// Move lat/lon by distance in meters at given angle
function moveCoord(lat, lon, distMeters, angleDeg) {
  const angleRad = (angleDeg * Math.PI) / 180;
  const dLat = (distMeters * Math.cos(angleRad)) / 111320;
  const dLon = (distMeters * Math.sin(angleRad)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

function generateDeviceId(substationIdx, dtId, poleNum) {
  const devNum = deviceCounter++;
  return `KSPDB-SD${String(substationIdx + 1).padStart(2, '0')}-${dtId}-${String(devNum).padStart(4, '0')}`;
}

function generatePoleId() {
  return `P-${String(poleCounter++).padStart(6, '0')}`;
}

function generateDTId(feederIdx) {
  return `D-${String(dtCounter++).padStart(4, '0')}`;
}

function generateFeederId(substationIdx) {
  const num = feederCounter++;
  return `F-${String(substationIdx + 1).padStart(2, '0')}-${String(num).padStart(2, '0')}`;
}

// ── Generation ────────────────────────────────────────────────────────────────

const substations = [];
const feeders = [];
const transformers = [];
const poles = [];

// Prepared statements
const insertSubstation = db.prepare('INSERT INTO substations (substation_id, name, lat, lon) VALUES (?, ?, ?, ?)');
const insertFeeder = db.prepare('INSERT INTO feeders (feeder_id, substation_id, name) VALUES (?, ?, ?)');
const insertTransformer = db.prepare('INSERT INTO transformers (dt_id, feeder_id, lat, lon, capacity_kva, households_served, has_topology) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insertPole = db.prepare('INSERT INTO poles (pole_id, lat, lon, feeder_id, dt_id, seq_on_line, parent_pole_id, pole_type, ward, pincode, device_id, firmware_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const insertPoleState = db.prepare("INSERT INTO pole_state (pole_id, energized, last_seen, last_seq) VALUES (?, 1, datetime('now'), 0)");

const insertAll = db.transaction(() => {
  console.log('Generating substations...');
  
  for (let si = 0; si < CONFIG.substations; si++) {
    const sc = SUBSTATION_CENTERS[si];
    const subId = `SS-${String(si + 1).padStart(2, '0')}`;
    insertSubstation.run(subId, sc.name, sc.lat, sc.lon);
    
    const numFeeders = CONFIG.feedersPerSubstation[si];
    
    for (let fi = 0; fi < numFeeders; fi++) {
      const feederId = generateFeederId(si);
      insertFeeder.run(feederId, subId, `Feeder ${feederId}`);
      
      const numDTs = rand(CONFIG.dtsPerFeeder.min, CONFIG.dtsPerFeeder.max);
      
      // Distribute DTs along the feeder in a roughly linear arrangement
      const feederAngle = (fi / numFeeders) * 360;
      
      for (let di = 0; di < numDTs; di++) {
        const dtId = generateDTId(fi);
        const dtDist = 300 + di * rand(80, 200);
        const dtAngleSpread = 25;
        const dtCoord = moveCoord(sc.lat, sc.lon, dtDist, feederAngle + randFloat(-dtAngleSpread, dtAngleSpread));
        
        const hasTopology = Math.random() < CONFIG.topologyKnownPercent ? 1 : 0;
        const capacity = pickRandom([100, 250, 250, 250, 500, 630]);
        const households = Math.round(capacity * randFloat(0.8, 1.5));
        
        insertTransformer.run(dtId, feederId, dtCoord.lat, dtCoord.lon, capacity, households, hasTopology);
        
        // Generate poles for this DT
        const numMainPoles = rand(CONFIG.polesPerDT.min, Math.min(CONFIG.polesPerDT.max, 80));
        const ward = pickRandom(WARDS);
        const pincode = Math.random() < CONFIG.missingPincodePercent ? null : pickRandom(PINCODES);
        
        // Main line direction
        const lineAngle = feederAngle + randFloat(-30, 30);
        const poleSpacing = rand(25, 45); // meters between poles
        
        let prevPoleId = null;
        let prevLat = dtCoord.lat;
        let prevLon = dtCoord.lon;
        const dtPoles = [];
        
        for (let pi = 0; pi < numMainPoles; pi++) {
          const poleId = generatePoleId();
          const coord = moveCoord(prevLat, prevLon, poleSpacing + rand(-5, 5), lineAngle + randFloat(-8, 8));
          
          const hasDevice = Math.random() < CONFIG.deviceCoverage;
          const devId = hasDevice ? generateDeviceId(si, dtId, pi) : null;
          const fw = hasDevice ? (Math.random() < CONFIG.firmwareOldPercent ? '1.2.4' : pickRandom(['1.3.1', '1.4.0', '1.4.2', '1.4.2', '1.4.2'])) : null;
          
          const seqOnLine = hasTopology ? pi + 1 : null;
          const parentId = hasTopology ? prevPoleId : null;
          
          insertPole.run(poleId, coord.lat, coord.lon, feederId, dtId, seqOnLine, parentId, pickRandom(POLE_TYPES), ward, pincode, devId, fw);
          insertPoleState.run(poleId);
          
          dtPoles.push({ poleId, lat: coord.lat, lon: coord.lon, seq: pi + 1 });
          prevPoleId = poleId;
          prevLat = coord.lat;
          prevLon = coord.lon;
          
          // Possibly branch
          if (pi > 3 && pi < numMainPoles - 2 && Math.random() < CONFIG.branchProbability) {
            const branchLen = rand(CONFIG.branchLength.min, CONFIG.branchLength.max);
            const branchAngle = lineAngle + (Math.random() < 0.5 ? 60 : -60) + randFloat(-15, 15);
            let bPrevId = poleId;
            let bLat = coord.lat;
            let bLon = coord.lon;
            
            for (let bi = 0; bi < branchLen; bi++) {
              const bPoleId = generatePoleId();
              const bCoord = moveCoord(bLat, bLon, poleSpacing + rand(-5, 5), branchAngle + randFloat(-5, 5));
              
              const bHasDevice = Math.random() < CONFIG.deviceCoverage;
              const bDevId = bHasDevice ? generateDeviceId(si, dtId, 100 + bi) : null;
              const bFw = bHasDevice ? (Math.random() < CONFIG.firmwareOldPercent ? '1.2.4' : '1.4.2') : null;
              
              const bSeq = hasTopology ? numMainPoles + dtPoles.length + bi + 1 : null;
              const bParent = hasTopology ? bPrevId : null;
              
              insertPole.run(bPoleId, bCoord.lat, bCoord.lon, feederId, dtId, bSeq, bParent, pickRandom(POLE_TYPES), ward, pincode, bDevId, bFw);
              insertPoleState.run(bPoleId);
              
              bPrevId = bPoleId;
              bLat = bCoord.lat;
              bLon = bCoord.lon;
            }
          }
        }
      }
    }
  }
  
  // Create a couple of default scheduled outages for demo
  const insertOutage = db.prepare('INSERT INTO scheduled_outages (outage_id, scope, target_id, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?, ?)');
  
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  
  insertOutage.run(
    `SO-${now.toISOString().slice(0, 10)}-001`,
    'feeder',
    'F-01-01',
    new Date(tomorrow.setHours(10, 0, 0, 0)).toISOString(),
    new Date(tomorrow.setHours(12, 30, 0, 0)).toISOString(),
    'Planned maintenance - jumper replacement'
  );
  
  insertOutage.run(
    `SO-${now.toISOString().slice(0, 10)}-002`,
    'dt',
    'D-0005',
    new Date(tomorrow.setHours(14, 0, 0, 0)).toISOString(),
    new Date(tomorrow.setHours(15, 0, 0, 0)).toISOString(),
    'Load shedding'
  );
});

// Execute
console.log('🔌 KSPDB Seed Data Generator');
console.log('━'.repeat(50));

insertAll();

// Print stats
const stats = {
  substations: db.prepare('SELECT COUNT(*) as c FROM substations').get().c,
  feeders: db.prepare('SELECT COUNT(*) as c FROM feeders').get().c,
  transformers: db.prepare('SELECT COUNT(*) as c FROM transformers').get().c,
  poles: db.prepare('SELECT COUNT(*) as c FROM poles').get().c,
  polesWithDevice: db.prepare('SELECT COUNT(*) as c FROM poles WHERE device_id IS NOT NULL').get().c,
  polesWithTopology: db.prepare('SELECT COUNT(*) as c FROM poles WHERE seq_on_line IS NOT NULL').get().c,
  dtsWithTopology: db.prepare('SELECT COUNT(*) as c FROM transformers WHERE has_topology = 1').get().c,
  totalDTs: db.prepare('SELECT COUNT(*) as c FROM transformers').get().c,
  fw12x: db.prepare("SELECT COUNT(*) as c FROM poles WHERE firmware_version LIKE '1.2%'").get().c,
  missingPincode: db.prepare('SELECT COUNT(*) as c FROM poles WHERE pincode IS NULL').get().c,
};

console.log(`\n✅ Seed complete!`);
console.log(`   Substations:        ${stats.substations}`);
console.log(`   Feeders:            ${stats.feeders}`);
console.log(`   Transformers:       ${stats.transformers} (${stats.dtsWithTopology} with topology = ${Math.round(stats.dtsWithTopology / stats.totalDTs * 100)}%)`);
console.log(`   Poles:              ${stats.poles}`);
console.log(`   Poles with device:  ${stats.polesWithDevice} (${Math.round(stats.polesWithDevice / stats.poles * 100)}%)`);
console.log(`   Poles with topology:${stats.polesWithTopology} (${Math.round(stats.polesWithTopology / stats.poles * 100)}%)`);
console.log(`   FW 1.2.x devices:  ${stats.fw12x}`);
console.log(`   Missing pincode:   ${stats.missingPincode}`);
console.log(`   DB path:           ${dbPath}`);
console.log('━'.repeat(50));

db.close();
