/**
 * Database connection singleton
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'kspdb.db');
let db = null;

function getDb() {
  if (!db) {
    // If DB doesn't exist, run seed
    if (!fs.existsSync(dbPath)) {
      console.log('Database not found, running seed...');
      require('./seed');
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb };
