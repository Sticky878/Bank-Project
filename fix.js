const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./fmc_bank.db');

// Find the test user
db.get("SELECT id FROM users WHERE email = 'test@test.com'", (err, user) => {
  if (err || !user) return console.error("User not found. Did you create test@test.com?");

  const userId = user.id;
  const fakeTransactions = [];

  // Generate 25 fake transactions
  for (let i = 1; i <= 25; i++) {
    const isDeposit = i % 2 === 0; // Alternates deposit and withdraw
    const amount = (Math.random() * 100 + 10).toFixed(2);
    const type = isDeposit ? 'deposit' : 'withdraw';
    
    // Make some descriptions searchable
    let description = `Fake Transaction #${i} - `;
    if (i % 3 === 0) description += 'Groceries';
    else if (i % 3 === 1) description += 'Salary Payment';
    else description += 'Coffee Shop';

    fakeTransactions.push([userId, type, parseFloat(amount), description]);
  }

  // Insert them into the database
  const stmt = db.prepare("INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)");
  
  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    fakeTransactions.forEach(txn => stmt.run(txn));
    stmt.finalize();
    db.run("COMMIT", (err) => {
      if (err) console.error("Error generating data:", err);
      else console.log("✅ Successfully injected 25 fake transactions into test@test.com!");
      db.close();
    });
  });
});