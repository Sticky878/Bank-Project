const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./fmc_bank.db');

db.all("SELECT id, email, status, must_change_password, password FROM users ORDER BY id DESC LIMIT 3", [], (err, rows) => {
  if (err) return console.error(err);
  console.table(rows.map(r => ({ 
    id: r.id, 
    email: r.email, 
    status: r.status, 
    mustChange: r.must_change_password,
    passwordHashStartsWith: r.password.substring(0, 10) + '...'
  })));
  db.close();
});