require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const webPush = require('web-push');
const AfricasTalking = require('africastalking');

const app = express();

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());

// ========== VAPID (Push Notifications) ==========
webPush.setVapidDetails(
  'mailto:luckyboyd837@gmail.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ========== AFRICA'S TALKING (SMS) ==========
const at = AfricasTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME
});
const sms = at.SMS;

// Temporary storage for reset codes (in production use Redis or database)
const resetCodes = {};

// ========== PUSH NOTIFICATIONS STORAGE ==========
const DB_FILE = './pushdb.json';
let pushDb = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : { subs: {}, recs: {} };

const savePushDb = () => fs.writeFileSync(DB_FILE, JSON.stringify(pushDb));

// ========== NOTCHPAY ==========
const NOTCHPAY_BASE = 'https://api.notchpay.co';
const PUBLIC_KEY = process.env.NOTCHPAY_PUBLIC_KEY;
const HASH_KEY = process.env.NOTCHPAY_HASH_KEY;

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'EasyRent backend is running',
    services: {
      notchpay: !!PUBLIC_KEY,
      push: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      sms: !!(process.env.AT_API_KEY && process.env.AT_USERNAME)
    }
  });
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================

// 1. Save push subscription
app.post('/api/push/subscribe', (req, res) => {
  const { phone, subscription } = req.body || {};
  if (!phone || !subscription) {
    return res.status(400).json({ error: 'missing fields' });
  }
  pushDb.subs[phone] = subscription;
  savePushDb();
  res.json({ ok: true });
});

// 2. Sync records for due date checking
app.post('/api/push/sync', (req, res) => {
  const { phone, records } = req.body || {};
  if (!phone || !records) {
    return res.status(400).json({ error: 'missing fields' });
  }
  pushDb.recs[phone] = records;
  savePushDb();
  res.json({ ok: true });
});

// 3. Daily check (call this with cron-job.org every morning)
app.get('/api/push/check', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  let sent = 0;

  for (const [phone, records] of Object.entries(pushDb.recs)) {
    const sub = pushDb.subs[phone];
    if (!sub) continue;

    const dues = records.filter(r => {
      const d = (r.expiryDate || '').slice(0, 10);
      return d === today || d === in7;
    });

    if (!dues.length) continue;

    const total = dues.reduce((s, r) => s + Number(r.amount || 0), 0);
    const names = dues.map(r => r.itemName).join(', ');

    try {
      await webPush.sendNotification(sub, JSON.stringify({
        title: 'Easy Rent — payments due',
        body: `${dues.length} due (${total.toLocaleString()} FCFA): ${names}`
      }));
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        delete pushDb.subs[phone];
        savePushDb();
      }
    }
  }

  res.json({ ok: true, sent });
});

// ============================================
// SMS - FORGOT PASSWORD
// ============================================

// Send verification code
app.post('/api/sms/send-code', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Save code for 10 minutes
    resetCodes[phone] = {
      code: code,
      expires: Date.now() + 10 * 60 * 1000
    };

    // Send SMS via Africa's Talking
    const result = await sms.send({
      to: [phone],
      message: `Your Easy Rent verification code is: ${code}. Valid for 10 minutes. Do not share this code.`,
      from: 'EasyRent'
    });

    console.log('SMS result:', JSON.stringify(result, null, 2));

    res.json({
      success: true,
      message: 'Verification code sent successfully'
    });

  } catch (error) {
    console.error('SMS Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send SMS. Please try again.'
    });
  }
});

// Verify the code
app.post('/api/sms/verify-code', (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ success: false, message: 'Phone and code are required' });
  }

  const saved = resetCodes[phone];

  if (!saved) {
    return res.json({
      success: false,
      message: 'No code found. Please request a new one.'
    });
  }

  if (Date.now() > saved.expires) {
    delete resetCodes[phone];
    return res.json({
      success: false,
      message: 'Code has expired. Please request a new one.'
    });
  }

  if (saved.code !== code.toString()) {
    return res.json({
      success: false,
      message: 'Incorrect code. Please try again.'
    });
  }

  // Code is correct
  delete resetCodes[phone];

  res.json({
    success: true,
    message: 'Code verified successfully'
  });
});

// ============================================
// NOTCHPAY PAYMENTS
// ============================================

// 1. Initialize payment
app.post('/api/pay/initiate', async (req, res) => {
  try {
    const { amount, currency, phone, email, reference, callback_url } = req.body;

    const response = await axios.post(
      `${NOTCHPAY_BASE}/payments`,
      {
        amount,
        currency: currency || 'XAF',
        phone,
        email,
        reference,
        callback: callback_url,
        description: 'EasyRent Premium Subscription'
      },
      {
        headers: {
          'Authorization': PUBLIC_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json({
      success: true,
      paymentUrl: response.data.authorization_url,
      reference: response.data.reference,
      transactionId: response.data.id
    });
  } catch (error) {
    console.error('NotchPay init error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.message || 'Payment initialization failed'
    });
  }
});

// 2. Verify payment
app.get('/api/pay/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    const response = await axios.get(
      `${NOTCHPAY_BASE}/payments/${reference}`,
      {
        headers: { 'Authorization': PUBLIC_KEY }
      }
    );

    res.json({
      status: response.data.status,
      data: response.data
    });
  } catch (error) {
    console.error('Verify error:', error.response?.data || error.message);
    res.status(500).json({
      status: 'error',
      message: 'Could not verify payment'
    });
  }
});

// 3. Webhook
app.post('/api/pay/webhook', (req, res) => {
  const signature = req.headers['x-notchpay-signature'];
  const payload = JSON.stringify(req.body);

  const expectedSig = crypto
    .createHmac('sha256', HASH_KEY)
    .update(payload)
    .digest('hex');

  if (signature !== expectedSig) {
    console.warn('Invalid webhook signature');
    return res.status(400).send('Invalid signature');
  }

  const event = req.body;
  console.log('Webhook received:', event.event, event.data?.reference);

  if (event.event === 'payment.complete') {
    console.log('Payment completed for reference:', event.data.reference);
  }

  res.status(200).send('OK');
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('========================================');
  console.log('  ✅ EasyRent Backend is running!');
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log('  Services:');
  console.log(`     - Payments (NotchPay): ${PUBLIC_KEY ? 'Yes' : 'No'}`);
  console.log(`     - Push Notifications: ${process.env.VAPID_PUBLIC_KEY ? 'Yes' : 'No'}`);
  console.log(`     - SMS (Africa's Talking): ${process.env.AT_API_KEY ? 'Yes' : 'No'}`);
  console.log('========================================');
});
