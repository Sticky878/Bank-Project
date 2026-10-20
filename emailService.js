const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 2525),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  console.log('📧 Email service ready');
  return transporter;
}

function buildTransactionHTML({ firstName, title, message, amount, type, balance, accountNumber, description }) {
  const isCredit = type === 'deposit';
  const amountColor = isCredit ? '#28a745' : '#dc3545';
  const amountSymbol = isCredit ? '+' : '−';

  return `
  <!DOCTYPE html><html><body style="font-family: Arial, sans-serif; background: #f4f7f6; margin: 0; padding: 30px;">
    <div style="max-width: 550px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
      <div style="background: linear-gradient(135deg, #ff7a00, #e66a00); padding: 25px; text-align: center;">
        <h1 style="color: #fff; margin: 0; font-size: 24px;">🏦 FMC Bank</h1>
      </div>
      <div style="padding: 30px;">
        <h2 style="color: #1a1a2e; margin-top: 0;">${title}</h2>
        <p style="color: #555; line-height: 1.6;">Hi ${firstName},</p>
        <p style="color: #555; line-height: 1.6;">${message}</p>
        <div style="background: #f8f9fa; border-left: 4px solid ${amountColor}; padding: 20px; border-radius: 8px; margin: 25px 0;">
          <p style="margin: 0; color: #888; font-size: 13px; text-transform: uppercase;">Transaction Amount</p>
          <p style="margin: 5px 0 0; font-size: 32px; font-weight: bold; color: ${amountColor};">${amountSymbol}$${parseFloat(amount).toFixed(2)}</p>
          ${description ? `<p style="margin: 8px 0 0; color: #777; font-size: 13px;">${description}</p>` : ''}
        </div>
        <table style="width: 100%; font-size: 14px; color: #555; margin-top: 20px;">
          <tr><td style="padding: 8px 0; color: #888;">Account Number:</td><td style="padding: 8px 0; font-weight: bold; text-align: right;">${accountNumber}</td></tr>
          <tr><td style="padding: 8px 0; color: #888;">New Balance:</td><td style="padding: 8px 0; font-weight: bold; text-align: right; color: #1a1a2e;">$${parseFloat(balance).toFixed(2)}</td></tr>
          <tr><td style="padding: 8px 0; color: #888;">Date:</td><td style="padding: 8px 0; text-align: right;">${new Date().toLocaleString('en-US')}</td></tr>
        </table>
      </div>
      <div style="background: #f8f9fa; padding: 20px; text-align: center; color: #888; font-size: 12px;">
        <p style="margin: 0;">This is an automated message from FMC Bank. Please do not reply.</p>
      </div>
    </div>
  </body></html>`;
}

async function sendTransactionEmail({ to, firstName, title, message, amount, type, balance, accountNumber, description }) {
  try {
    const t = getTransporter();
    const info = await t.sendMail({
      from: process.env.SMTP_FROM || '"FMC Bank" <notifications@fmcbank.com>',
      to,
      subject: title,
      html: buildTransactionHTML({ firstName, title, message, amount, type, balance, accountNumber, description })
    });
    console.log(`📧 Email sent to ${to}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('❌ Email error:', err.message);
    return { success: false, error: err.message };
  }
}

function buildResetHTML({ firstName, resetLink }) {
  return `
  <!DOCTYPE html><html><body style="font-family: Arial, sans-serif; background: #f4f7f6; margin: 0; padding: 30px;">
    <div style="max-width: 550px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
      <div style="background: linear-gradient(135deg, #ff7a00, #e66a00); padding: 25px; text-align: center;">
        <h1 style="color: #fff; margin: 0;">🏦 FMC Bank</h1>
      </div>
      <div style="padding: 30px;">
        <h2 style="color: #1a1a2e; margin-top: 0;">Password Reset Request</h2>
        <p style="color: #555; line-height: 1.6;">Hi ${firstName},</p>
        <p style="color: #555; line-height: 1.6;">We received a request to reset your password. This link expires in <strong>15 minutes</strong>.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background: #ff7a00; color: #fff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Reset My Password</a>
        </div>
        <p style="color: #888; font-size: 13px;">If the button doesn't work, copy this link:<br><span style="color: #ff7a00; word-break: break-all;">${resetLink}</span></p>
        <p style="color: #888; font-size: 12px;">If you didn't request this, ignore this email — your password won't change.</p>
      </div>
    </div>
  </body></html>`;
}

async function sendPasswordResetEmail({ to, firstName, resetLink }) {
  try {
    const t = getTransporter();
    await t.sendMail({
      from: process.env.SMTP_FROM || '"FMC Bank" <no-reply@fmcbank.com>',
      to,
      subject: '🔐 FMC Bank - Password Reset',
      html: buildResetHTML({ firstName, resetLink })
    });
    console.log(`📧 Password reset email sent to ${to}`);
    return { success: true };
  } catch (err) {
    console.error('❌ Reset email error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendTransactionEmail, sendPasswordResetEmail };