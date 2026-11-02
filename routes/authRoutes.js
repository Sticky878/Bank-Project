const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { run, get, all } = require('../database');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function generateAccountNumber() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const num = 'FMC-' + crypto.randomInt(10000000, 99999999);
    const existing = await get('SELECT id FROM users WHERE account_number = ?', [num]);
    if (!existing) return num;
  }
  throw new Error('Could not generate unique account number');
}

// ===== POST /api/register =====
router.post('/register', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, password } = req.body || {};

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const emailLower = email.toLowerCase().trim();
    const existing = await get('SELECT id FROM users WHERE email = ?', [emailLower]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const accountNumber = await generateAccountNumber();
    const hashed = await bcrypt.hash(password, 10);

    await run(
      `INSERT INTO users (account_number, first_name, last_name, email, phone, password, role, balance)
       VALUES (?, ?, ?, ?, ?, ?, 'user', 0.0)`,
      [accountNumber, firstName.trim(), lastName.trim(), emailLower, phone || null, hashed]
    );

    res.status(201).json({ success: true, accountNumber, message: 'Account created successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ===== POST /api/login =====
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await get('SELECT * FROM users WHERE email = ? AND status = ?', [email.toLowerCase().trim(), 'active']);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
      account_number: user.account_number,
      balance: user.balance
    };

    res.json({
      success: true,
      user: req.session.user,
      mustChangePassword: !!user.must_change_password,
      redirect: user.role === 'admin' ? '/admin.html' : '/dashboard.html'
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ===== POST /api/logout =====
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// ===== GET /api/me =====
router.get('/me', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  try {
    // Fetch fresh data directly from the database!
    const user = await get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      first_name: user.first_name,
      last_name: user.last_name,
      account_number: user.account_number,
      balance: user.balance
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== GET /api/transactions =====
router.get('/transactions', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  try {
    const countRow = await get(
      `SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND (description LIKE ? OR type LIKE ?)`, 
      [req.session.user.id, `%${search}%`, `%${search}%`]
    );
    const totalPages = Math.ceil(countRow.count / limit);

    const transactions = await all(
      `SELECT * FROM transactions 
       WHERE user_id = ? AND (description LIKE ? OR type LIKE ?) 
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [req.session.user.id, `%${search}%`, `%${search}%`, limit, offset]
    );

    res.json({ transactions, currentPage: page, totalPages });
  } catch (err) {
    console.error('Transactions DB error:', err);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ===== GET /api/lookup-account/:accountNumber =====
router.get('/lookup-account/:accountNumber', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  try {
    const user = await get('SELECT first_name, last_name FROM users WHERE account_number = ?', [req.params.accountNumber]);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ===== POST /api/transfer =====
router.post('/transfer', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });

  const { recipientAccount, amount, description } = req.body;
  const amt = Number(amount);

  if (!recipientAccount || !amt || amt <= 0) return res.status(400).json({ error: 'Invalid transfer details' });

  try {
    const sender = await get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const recipient = await get('SELECT * FROM users WHERE account_number = ?', [recipientAccount]);

    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });
    if (sender.account_number === recipientAccount) return res.status(400).json({ error: 'Cannot transfer to yourself' });
    if (sender.balance < amt) return res.status(400).json({ error: 'Insufficient funds' });

    // Perform transfer
    await run('UPDATE users SET balance = balance - ? WHERE id = ?', [amt, sender.id]);
    await run('UPDATE users SET balance = balance + ? WHERE id = ?', [amt, recipient.id]);

    // Log transactions
    await run(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'withdrawal', ?, ?)`, 
      [sender.id, amt, `Transfer to ${recipientAccount}: ${description || ''}`]);
    await run(`INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'deposit', ?, ?)`, 
      [recipient.id, amt, `Transfer from ${sender.account_number}: ${description || ''}`]);

    // Update the session variable just to be safe
    req.session.user.balance = sender.balance - amt;

    res.json({ success: true, message: 'Transfer successful' });
  } catch (err) {
    console.error('Transfer error:', err);
    res.status(500).json({ error: 'Transfer failed' });
  }
});

// ===== POST /api/change-password =====
router.post('/change-password', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password too short' });

  try {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Incorrect current password' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await run('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', [hashed, user.id]);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Password change failed' });
  }
});

module.exports = router;