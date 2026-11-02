const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = process.env.DB_DIR 
  ? path.join(process.env.DB_DIR, 'fmc_bank.db') 
  : path.join(__dirname, 'fmc_bank.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database opening error: ', err.message);
  else console.log(`Connected to FMC Bank SQLite database at ${dbPath}`);
});

// Promisified helpers so the rest of the app can use async/await cleanly.
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_number TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    balance REAL DEFAULT 0.0,
    reset_token TEXT,
    reset_token_expires DATETIME,
    must_change_password INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target_user_id INTEGER,
    details TEXT,
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Migration-safe admin bootstrap. Runs once after CREATE TABLE statements flush.
async function bootstrapAdmin() {
  try {
    const existing = await get(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    if (existing) return;

    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      console.warn(
        '⚠️  No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set. Skipping bootstrap.'
      );
      return;
    }

    const hashed = bcrypt.hashSync(password, 10);
    await run(
      `INSERT INTO users (account_number, first_name, last_name, email, password, role, balance, must_change_password)
       VALUES ('FMC-ADMIN', 'Admin', 'User', ?, ?, 'admin', 0.0, 1)`,
      [email, hashed]
    );

    console.log('=======================================');
    console.log('✅ Admin bootstrapped. Rotate password on first login.');
    console.log(`   Email: ${email}`);
    console.log('=======================================');
  } catch (err) {
    console.error('Admin bootstrap error:', err.message);
  }
}

// Give SQLite a tick to finish the CREATE TABLEs, then bootstrap.
setTimeout(bootstrapAdmin, 200);

module.exports = { db, run, get, all, exec };