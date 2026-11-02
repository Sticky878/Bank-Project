const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { run, get, all } = require('../database');
const { sendTransactionEmail } = require('../emailService');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ===== GET /api/admin/users =====
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await all(
      `SELECT id, account_number, first_name, last_name, email, phone, balance, role, status, created_at
       FROM users ORDER BY created_at DESC`
    );
    res.json(users);
  } catch (err) {
    console.error('Load users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ===== POST /api/admin/users =====
router.post('/users', requireAdmin, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, initialBalance } = req.body || {};
    if (!firstName || !lastName || !email) return res.status(400).json({ error: 'First name, last name, and email required' });

    const emailLower = email.toLowerCase().trim();
    const existing = await get('SELECT id FROM users WHERE email = ?', [emailLower]);
    if (existing) return res.status(409).json({ error: 'Email already exists' });

    const accountNumber = 'FMC-' + crypto.randomInt(10000000, 99999999);
    const tempPassword = 'fmc12345';
    const hashed = await bcrypt.hash(tempPassword, 10);
    const balance = Number(initialBalance) || 0;

    const result = await run(
      `INSERT INTO users (account_number, first_name, last_name, email, phone, password, role, balance, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 'user', ?, 1)`,
      [accountNumber, firstName.trim(), lastName.trim(), emailLower, phone || null, hashed, balance]
    );

    if (balance > 0) {
      await run(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'deposit', ?, 'Initial balance set by admin')`, [result.lastID, balance]);
    }
    await run(`INSERT INTO audit_log (actor_id, action, target_user_id, details, ip) VALUES (?, 'create_user', ?, ?, ?)`, [req.session.user.id, result.lastID, `Created user ${emailLower}`, req.ip]);

    res.status(201).json({ success: true, accountNumber, userId: result.lastID, defaultPassword: tempPassword });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ===== POST /api/admin/balance =====
router.post('/balance', requireAdmin, async (req, res) => {
  try {
    const { userId, type, amount, description } = req.body || {};
    if (!userId || !type || !amount) return res.status(400).json({ error: 'Missing fields' });
    if (!['deposit', 'withdrawal'].includes(type)) return res.status(400).json({ error: 'Invalid transaction type' });

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });

    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const delta = type === 'deposit' ? amt : -amt;
    const newBalance = Number((user.balance + delta).toFixed(2));
    if (newBalance < 0) return res.status(400).json({ error: 'Insufficient balance for withdrawal' });

    await run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, userId]);
    await run(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)`, [userId, type, amt, description || null]);
    await run(`INSERT INTO audit_log (actor_id, action, target_user_id, details, ip) VALUES (?, 'balance_change', ?, ?, ?)`, [req.session.user.id, userId, `${type} $${amt.toFixed(2)} — ${description || ''}`, req.ip]);

    // Fire-and-forget email
    sendTransactionEmail({
      to: user.email, firstName: user.first_name,
      title: type === 'deposit' ? 'Deposit Received' : 'Withdrawal Processed',
      message: `Your account has been ${type === 'deposit' ? 'credited' : 'debited'}.`,
      amount: amt, type, balance: newBalance, accountNumber: user.account_number, description
    }).catch(e => console.error('Email fire error:', e.message));

    res.json({ success: true, newBalance });
  } catch (err) {
    console.error('Balance update error:', err);
    res.status(500).json({ error: 'Balance update failed' });
  }
});

// ===== GET /api/admin/analytics =====
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const monthly = await all(`
      SELECT strftime('%Y-%m', created_at) AS month,
             SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END) AS deposits,
             SUM(CASE WHEN type = 'withdrawal' THEN amount ELSE 0 END) AS withdrawals
      FROM transactions GROUP BY month ORDER BY month DESC LIMIT 12
    `);
    const topUsers = await all(`
      SELECT u.first_name, u.last_name, u.account_number, u.balance, COUNT(t.id) AS txn_count
      FROM users u LEFT JOIN transactions t ON t.user_id = u.id
      WHERE u.role = 'user' GROUP BY u.id ORDER BY txn_count DESC LIMIT 5
    `);
    const recent = await all(`
      SELECT t.id, t.type, t.amount, t.description, t.created_at, u.first_name, u.last_name, u.account_number
      FROM transactions t JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 10
    `);
    res.json({ monthly, topUsers, recent });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

module.exports = router;