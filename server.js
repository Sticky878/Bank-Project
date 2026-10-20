require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');

const { run, get, all, exec } = require('./database');
const { sendTransactionEmail, sendPasswordResetEmail } = require('./emailService');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_PROD = process.env.NODE_ENV === 'production';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET missing or too short. Set it in .env.');
  process.exit(1);
}

// --- GLOBAL MIDDLEWARE ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
        scriptSrcAttr: ["'unsafe-inline'"], // <--- THE FIX: Allows onclick="..." attributes
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
        imgSrc: ["'self'", "data:"]
      }
    }
  })
);
app.use(morgan(IS_PROD ? 'combined' : 'dev'));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const cookieOpts = {
  httpOnly: true,
  secure: false, // Force false for local testing
  sameSite: 'lax', // Lax is more forgiving for localhost redirects
  path: '/'
};

// --- RATE LIMITERS ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' }
});
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset requests. Try again later.' }
});
const transferLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many transfers. Slow down.' }
});

// --- VALIDATION HELPERS ---
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phoneRe = /^\+?[\d\s-]{7,15}$/;
const accountRe = /^FMC-\d{6}$/;

function passwordIssue(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-zA-Z]/.test(pw)) return 'Password must contain a letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain a number.';
  return null;
}

// --- AUTH MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  const token = req.cookies.auth_token;
  if (!token) return res.status(401).json({ error: 'Access denied. Please log in.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid session.' });
    req.user = user;
    next();
  });
};

const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
};

// --- AUDIT HELPER ---
async function audit(actorId, action, targetUserId, details, ip) {
  try {
    await run(
      `INSERT INTO audit_log (actor_id, action, target_user_id, details, ip) VALUES (?, ?, ?, ?, ?)`,
      [actorId, action, targetUserId || null, details || null, ip || null]
    );
  } catch (e) {
    console.error('Audit log failed:', e.message);
  }
}

// ===================== AUTH ROUTES =====================

app.post('/api/register', authLimiter, async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, password } = req.body || {};

    if (!firstName || !lastName || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!emailRe.test(email)) return res.status(400).json({ error: 'Invalid email.' });
    if (!phoneRe.test(phone)) return res.status(400).json({ error: 'Invalid phone number.' });
    const pwIssue = passwordIssue(password);
    if (pwIssue) return res.status(400).json({ error: pwIssue });

    const existing = await get(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing) return res.status(400).json({ error: 'Email already registered.' });

    const hashed = await bcrypt.hash(password, 10);
    let accountNumber;
    for (let i = 0; i < 5; i++) {
      const candidate = 'FMC-' + crypto.randomInt(100000, 1000000);
      const clash = await get(`SELECT id FROM users WHERE account_number = ?`, [candidate]);
      if (!clash) { accountNumber = candidate; break; }
    }
    if (!accountNumber) return res.status(500).json({ error: 'Could not generate account number.' });

    await run(
      `INSERT INTO users (account_number, first_name, last_name, email, phone, password) VALUES (?, ?, ?, ?, ?, ?)`,
      [accountNumber, firstName, lastName, email, phone, hashed]
    );

    res.json({ message: 'Account created successfully', accountNumber });
  } catch (err) { next(err); }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password, remember } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const user = await get(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) return res.status(400).json({ error: 'Invalid credentials.' });
    if (user.status !== 'active') return res.status(403).json({ error: 'Account is not active.' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials.' });

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.first_name },
      JWT_SECRET,
      { expiresIn: remember ? '30d' : '1d' }
    );
    res.cookie('auth_token', token, {
      ...cookieOpts,
      maxAge: (remember ? 30 * 24 * 60 * 60 : 24 * 60 * 60) * 1000
    });

    res.json({
      message: 'Login successful',
      role: user.role,
      mustChangePassword: !!user.must_change_password
    });
  } catch (err) { next(err); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('auth_token', cookieOpts);
  res.json({ message: 'Logged out' });
});

// --- GET CURRENT USER DATA (/api/me) ---
app.get('/api/me', authenticateToken, async (req, res, next) => {
  try {
    const user = await get(
      `SELECT id, account_number, first_name, last_name, email, role, balance, must_change_password FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { next(err); }
});

// --- TRANSACTIONS & EXPORT ---
app.get('/api/transactions', authenticateToken, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const offset = (page - 1) * limit;

    let whereClause = `WHERE user_id = ?`;
    let params = [req.user.id];

    if (search) {
      whereClause += ` AND (description LIKE ? OR type LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const countResult = await get(`SELECT COUNT(*) as total FROM transactions ${whereClause}`, params);
    const total = countResult.total;

    const rows = await all(
      `SELECT * FROM transactions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      transactions: rows,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      totalRecords: total
    });
  } catch (err) { next(err); }
});

app.get('/api/transactions/export', authenticateToken, async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT created_at, description, type, amount FROM transactions WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No transactions to export.' });
    }

    let csv = 'Date,Description,Type,Amount\n';
    rows.forEach(t => {
      const safeDesc = (t.description || 'No description').replace(/,/g, '');
      const sign = t.type === 'deposit' ? '+' : '-';
      csv += `"${new Date(t.created_at).toLocaleString()}","${safeDesc}","${t.type}","${sign}${t.amount.toFixed(2)}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="FMC_Bank_Statement.csv"');
    res.status(200).send(csv);

  } catch (err) { next(err); }
});

// ===================== P2P TRANSFER =====================

app.post('/api/transfer', authenticateToken, transferLimiter, async (req, res, next) => {
  try {
    const { recipientAccount, amount, description } = req.body || {};
    const senderId = req.user.id;

    if (!recipientAccount || !accountRe.test(recipientAccount)) {
      return res.status(400).json({ error: 'Invalid recipient account number.' });
    }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
      return res.status(400).json({ error: 'Amount must be between 0.01 and 1,000,000.' });
    }
    if (description && description.length > 200) {
      return res.status(400).json({ error: 'Description too long (max 200).' });
    }

    const recipient = await get(
      `SELECT id, account_number, first_name, last_name, balance FROM users WHERE account_number = ?`,
      [recipientAccount]
    );
    if (!recipient) return res.status(404).json({ error: 'Recipient not found.' });
    if (recipient.id === senderId) return res.status(400).json({ error: 'You cannot transfer to yourself.' });

    await exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const sender = await get(`SELECT balance, first_name FROM users WHERE id = ?`, [senderId]);
      if (sender.balance < value) throw new Error('INSUFFICIENT_FUNDS');

      const newSenderBalance = sender.balance - value;
      const newRecipientBalance = recipient.balance + value;

      await run(`UPDATE users SET balance = ? WHERE id = ?`, [newSenderBalance, senderId]);
      await run(`UPDATE users SET balance = ? WHERE id = ?`, [newRecipientBalance, recipient.id]);

      await run(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'withdraw', ?, ?)`,
        [senderId, value, `Transfer to ${recipient.first_name} ${recipient.last_name} (${recipient.account_number}) - ${description || 'No description'}`]
      );
      await run(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'deposit', ?, ?)`,
        [recipient.id, value, `Transfer from ${sender.first_name} - ${description || 'No description'}`]
      );

      await exec('COMMIT');
      committed = true;

      const senderRow = await get(`SELECT email FROM users WHERE id = ?`, [senderId]);
      const recRow = await get(`SELECT email FROM users WHERE id = ?`, [recipient.id]);

      if (senderRow) {
        sendTransactionEmail({
          to: senderRow.email, firstName: sender.first_name,
          title: '💸 Transfer Sent',
          message: `You sent money to ${recipient.first_name} ${recipient.last_name}.`,
          amount: value, type: 'withdraw', balance: newSenderBalance,
          accountNumber: recipient.account_number,
          description: description || 'P2P Transfer'
        });
      }
      if (recRow) {
        sendTransactionEmail({
          to: recRow.email, firstName: recipient.first_name,
          title: '💰 Money Received',
          message: `You received money from ${sender.first_name}.`,
          amount: value, type: 'deposit', balance: newRecipientBalance,
          accountNumber: recipient.account_number,
          description: description || 'P2P Transfer'
        });
      }

      res.json({
        message: `Successfully transferred $${value.toFixed(2)} to ${recipient.first_name} ${recipient.last_name}`,
        newBalance: newSenderBalance
      });
    } catch (e) {
      if (!committed) await exec('ROLLBACK').catch(() => {});
      if (e.message === 'INSUFFICIENT_FUNDS') {
        return res.status(400).json({ error: 'Insufficient funds.' });
      }
      throw e;
    }
  } catch (err) { next(err); }
});

app.get('/api/lookup-account/:accountNumber', authenticateToken, async (req, res, next) => {
  try {
    const { accountNumber } = req.params;
    if (!accountRe.test(accountNumber)) return res.status(400).json({ error: 'Invalid account number.' });
    const user = await get(
      `SELECT first_name, last_name, account_number FROM users WHERE account_number = ?`,
      [accountNumber]
    );
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json(user);
  } catch (err) { next(err); }
});

// ===================== ADMIN ROUTES =====================

app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT id, account_number, first_name, last_name, email, phone, balance, role, status, created_at FROM users ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/admin/users', authenticateToken, isAdmin, async (req, res, next) => {
  try {
    const { firstName, lastName, email, phone, initialBalance } = req.body || {};
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: 'First name, last name, email required.' });
    }
    if (!emailRe.test(email)) return res.status(400).json({ error: 'Invalid email.' });

    const tempPassword = crypto.randomBytes(4).toString('hex');
    const hashed = await bcrypt.hash(tempPassword, 10);

    let accountNumber;
    for (let i = 0; i < 5; i++) {
      const candidate = 'FMC-' + crypto.randomInt(100000, 1000000);
      const clash = await get(`SELECT id FROM users WHERE account_number = ?`, [candidate]);
      if (!clash) { accountNumber = candidate; break; }
    }
    if (!accountNumber) return res.status(500).json({ error: 'Could not generate account number.' });

    const bal = Number(initialBalance) || 0;
    const result = await run(
      `INSERT INTO users (account_number, first_name, last_name, email, phone, password, balance, must_change_password, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active')`,
      [accountNumber, firstName, lastName, email, phone || null, hashed, bal]
    );

    if (bal > 0) {
      await run(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'deposit', ?, 'Initial Deposit by Admin')`,
        [result.lastID, bal]
      );
      sendTransactionEmail({
        to: email, firstName,
        title: '🎉 Welcome to FMC Bank',
        message: 'Your account has been created. Please change your password on first login.',
        amount: bal, type: 'deposit', balance: bal,
        accountNumber, description: 'Initial Deposit by Admin'
      });
    }

    await audit(req.user.id, 'admin_create_user', result.lastID, `Created ${email}`, req.ip);
    res.json({ message: 'User created', accountNumber, tempPassword });
  } catch (err) { next(err); }
});

app.post('/api/admin/balance', authenticateToken, isAdmin, async (req, res, next) => {
  try {
    const { userId, amount, type, description } = req.body || {};
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Invalid amount.' });
    if (type !== 'deposit' && type !== 'withdraw') return res.status(400).json({ error: 'Invalid type.' });

    const user = await get(`SELECT id, balance, first_name, email, account_number FROM users WHERE id = ?`, [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let newBalance = user.balance;
    if (type === 'deposit') newBalance += value;
    else {
      if (newBalance < value) return res.status(400).json({ error: 'Insufficient funds.' });
      newBalance -= value;
    }

    await exec('BEGIN IMMEDIATE');
    try {
      await run(`UPDATE users SET balance = ? WHERE id = ?`, [newBalance, userId]);
      await run(
        `INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)`,
        [userId, type, value, description || `Admin ${type}`]
      );
      await exec('COMMIT');
    } catch (e) {
      await exec('ROLLBACK').catch(() => {});
      throw e;
    }

    sendTransactionEmail({
      to: user.email, firstName: user.first_name,
      title: type === 'deposit' ? '💰 Deposit Received' : '💸 Withdrawal Alert',
      message: type === 'deposit' ? 'Your account has been credited.' : 'Your account has been debited.',
      amount: value, type, balance: newBalance,
      accountNumber: user.account_number,
      description: description || 'No description'
    });

    await audit(req.user.id, `admin_${type}`, userId, `$${value}`, req.ip);
    res.json({ message: `Successfully processed ${type}`, newBalance });
  } catch (err) { next(err); }
});

app.get('/api/admin/analytics', authenticateToken, isAdmin, async (req, res, next) => {
  try {
    const stats = await get(
      `SELECT COUNT(*) as total_users, COALESCE(SUM(balance), 0) as total_cash FROM users WHERE role = 'user'`
    );
    const monthly = await all(`
      SELECT strftime('%Y-%m', created_at) as month,
             SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END) as deposits,
             SUM(CASE WHEN type = 'withdraw' THEN amount ELSE 0 END) as withdrawals
      FROM transactions
      WHERE created_at >= datetime('now', '-6 months')
      GROUP BY month ORDER BY month ASC
    `);
    const topUsers = await all(`
      SELECT u.first_name, u.last_name, u.account_number, COUNT(t.id) as txn_count, u.balance
      FROM users u LEFT JOIN transactions t ON t.user_id = u.id
      WHERE u.role = 'user'
      GROUP BY u.id ORDER BY txn_count DESC LIMIT 5
    `);
    const recent = await all(`
      SELECT t.id, t.type, t.amount, t.description, t.created_at,
             u.first_name, u.last_name, u.account_number
      FROM transactions t JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC LIMIT 10
    `);
    res.json({ total_users: stats.total_users, total_cash: stats.total_cash, monthly, topUsers, recent });
  } catch (err) { next(err); }
});

// ===================== PASSWORD MANAGEMENT =====================

app.post('/api/change-password', authenticateToken, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    const pwIssue = passwordIssue(newPassword);
    if (pwIssue) return res.status(400).json({ error: pwIssue });
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must differ from current.' });
    }

    const user = await get(`SELECT password FROM users WHERE id = ?`, [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await run(`UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?`, [hashed, req.user.id]);
    
    res.json({ message: 'Password changed successfully.' });
  } catch (err) { next(err); }
});

app.post('/api/forgot-password', forgotLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await get(`SELECT id, first_name, email FROM users WHERE email = ?`, [email]);
    
    if (!user) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await run(`UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?`, [token, expires, user.id]);

    const resetLink = `${BASE_URL}/reset-password.html?token=${token}`;
    await sendPasswordResetEmail({ to: user.email, firstName: user.first_name, resetLink });

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

app.post('/api/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required.' });
    
    const pwIssue = passwordIssue(newPassword);
    if (pwIssue) return res.status(400).json({ error: pwIssue });

    const user = await get(
      `SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > datetime('now')`,
      [token]
    );
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token.' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await run(`UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`, [hashed, user.id]);
    
    res.json({ message: 'Password reset successful. You can now log in.' });
  } catch (err) { next(err); }
});

// ===================== GLOBAL ERROR HANDLER =====================
app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err);
  const message = IS_PROD ? 'An unexpected error occurred.' : err.message;
  res.status(500).json({ error: message });
});

// ===================== START SERVER =====================
app.listen(PORT, () => {
  console.log('========================================');
  console.log(`🚀 FMC Bank running at ${BASE_URL}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('========================================');
});