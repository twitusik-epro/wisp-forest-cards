'use strict';
require('dotenv').config();

const express    = require('express');
const path       = require('path');
const cors       = require('cors');
const passport   = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const jwt        = require('jsonwebtoken');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');
const { google } = require('googleapis');
const Database   = require('better-sqlite3');

// ─── Config ────────────────────────────────────────────────────────────────
const PORT               = process.env.PORT               || 3002;
const BASE_URL           = process.env.BASE_URL           || `http://localhost:${PORT}`;
const JWT_SECRET         = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID   = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PADDLE_API_KEY     = process.env.PADDLE_API_KEY;
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;
const PADDLE_ENV         = process.env.PADDLE_ENV || 'sandbox';
const NODE_ENV           = process.env.NODE_ENV || 'development';
const ADMIN_USER         = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS         = process.env.ADMIN_PASS || 'changeme';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('BŁĄD: JWT_SECRET nie ustawiony lub za krótki (min 32 znaki)!');
  process.exit(1);
}

// ─── Database ──────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'database', 'forestcards.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id    TEXT UNIQUE,
    email        TEXT UNIQUE,
    nick         TEXT,
    avatar_url   TEXT,
    mushrooms    INTEGER DEFAULT 0,
    wins         INTEGER DEFAULT 0,
    battle_level INTEGER DEFAULT 1,
    score        INTEGER DEFAULT 0,
    collection   TEXT DEFAULT '[]',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login   DATETIME,
    progress_ts  INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS scores (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    score        INTEGER,
    wins         INTEGER,
    battle_level INTEGER,
    guest_nick   TEXT,
    device_id    TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_scores_device ON scores(device_id);

  CREATE TABLE IF NOT EXISTS purchases (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
    paddle_txn_id  TEXT UNIQUE,
    package_id     TEXT,
    mushrooms      INTEGER,
    amount_eur_ct  INTEGER,
    status         TEXT DEFAULT 'pending',
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Prepared statements
const stmts = {
  upsertUser: db.prepare(`
    INSERT INTO users (google_id, email, nick, avatar_url, last_login)
    VALUES (@google_id, @email, @nick, @avatar_url, CURRENT_TIMESTAMP)
    ON CONFLICT(google_id) DO UPDATE SET
      email      = excluded.email,
      nick       = COALESCE(users.nick, excluded.nick),
      avatar_url = excluded.avatar_url,
      last_login = CURRENT_TIMESTAMP
    RETURNING *
  `),
  getUserById:        db.prepare('SELECT * FROM users WHERE id = ?'),
  getPurchaseByToken: db.prepare('SELECT id FROM purchases WHERE paddle_txn_id = ?'),
  addMushrooms:       db.prepare('UPDATE users SET mushrooms = mushrooms + ? WHERE id = ?'),
  insertScore:        db.prepare('INSERT INTO scores (user_id, score, wins, battle_level) VALUES (?, ?, ?, ?)'),
  insertGuestScore:   db.prepare('INSERT INTO scores (guest_nick, score, wins, battle_level, device_id) VALUES (?, ?, ?, ?, ?)'),
  topScores: db.prepare(`
    SELECT nick,
           MAX(avatar_url) AS avatar_url,
           MAX(score)      AS score,
           MAX(wins)       AS wins
    FROM (
      SELECT COALESCE(u.nick, s.guest_nick, 'Gość') AS nick,
             u.avatar_url,
             MAX(s.score)  AS score,
             MAX(s.wins)   AS wins
      FROM scores s
      LEFT JOIN users u ON u.id = s.user_id
      GROUP BY COALESCE(s.user_id || '', s.device_id, s.guest_nick)
    )
    GROUP BY nick
    ORDER BY score DESC
    LIMIT 20
  `),
  insertPurchase: db.prepare(`
    INSERT OR IGNORE INTO purchases (user_id, paddle_txn_id, package_id, mushrooms, amount_eur_ct, status)
    VALUES (@user_id, @paddle_txn_id, @package_id, @mushrooms, @amount_eur_ct, 'completed')
  `),
  saveProgress: db.prepare(`
    UPDATE users
    SET mushrooms    = ?,
        wins         = MAX(wins, ?),
        battle_level = MAX(battle_level, ?),
        score        = MAX(score, ?),
        collection   = ?,
        progress_ts  = ?
    WHERE id = ?
  `),
  resetProgress: db.prepare(`
    UPDATE users
    SET mushrooms    = ?,
        wins         = ?,
        battle_level = ?,
        score        = ?,
        collection   = ?,
        progress_ts  = ?
    WHERE id = ?
  `),

  // Admin
  listUsers:       db.prepare(`SELECT id, nick, email, mushrooms, wins, battle_level, score, created_at, last_login FROM users ORDER BY created_at DESC LIMIT 200`),
  searchUsers:     db.prepare(`SELECT id, nick, email, mushrooms, wins, battle_level, score, created_at, last_login FROM users WHERE nick LIKE @q OR email LIKE @q ORDER BY created_at DESC LIMIT 50`),
  deleteUser:      db.prepare('DELETE FROM users WHERE id = ?'),
  setMushrooms:    db.prepare('UPDATE users SET mushrooms = ? WHERE id = ?'),
  statsUsers:      db.prepare(`SELECT COUNT(*) as total, COUNT(CASE WHEN last_login > datetime('now','-7 days') THEN 1 END) as active_7d, COUNT(CASE WHEN last_login > datetime('now','-30 days') THEN 1 END) as active_30d, COUNT(CASE WHEN created_at > datetime('now','-7 days') THEN 1 END) as new_7d FROM users`),
  statsPurchases:  db.prepare(`SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN status='completed' THEN amount_eur_ct ELSE 0 END),0) as revenue_ct, COUNT(CASE WHEN status='completed' THEN 1 END) as completed FROM purchases`),
  recentPurchases: db.prepare(`SELECT p.id, p.user_id, p.package_id, p.mushrooms, p.amount_eur_ct, p.status, p.created_at, u.nick, u.email FROM purchases p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC LIMIT 100`),
  purgeOldUsers:   db.prepare(`DELETE FROM users WHERE last_login < datetime('now','-90 days') AND last_login IS NOT NULL`),
};

// ─── Paddle ────────────────────────────────────────────────────────────────
const paddle = PADDLE_API_KEY ? new Paddle(PADDLE_API_KEY, {
  environment: PADDLE_ENV === 'production' ? Environment.Production : Environment.Sandbox,
}) : null;

// Uzupełnij price_id po dodaniu produktów w Paddle Dashboard
const PACKAGES = {
  fc_pack_10:  { mushrooms: 10, lives: 0, amount:  99, price_id: 'pri_01kp0pyrvhz6ejvv3ngg20e6t9', price_display: '0,99 €' },
  fc_pack_25:  { mushrooms: 25, lives: 0, amount: 199, price_id: 'pri_01kp0q4j0v58xg561wreg8amjj', price_display: '1,99 €' },
  fc_pack_50:  { mushrooms: 50, lives: 0, amount: 399, price_id: 'pri_01kp0q66jqd3hp0bf3h5dsh2np', price_display: '3,99 €' },
  // Życia — price_id do uzupełnienia po dodaniu produktu w Paddle Dashboard
  fc_lives_3:  { mushrooms: 0,  lives: 3, amount:  99, price_id: '', price_display: '0,99 €' },
};

// ─── Express App ───────────────────────────────────────────────────────────
const app = express();

// Paddle webhook musi dostać raw body — PRZED express.json()
app.post('/webhook/paddle', express.raw({ type: 'application/json' }), handlePaddleWebhook);

app.use(cors({ origin: BASE_URL, credentials: true }));
app.use(express.json());
app.use(passport.initialize());

// ─── Admin Routes ───────────────────────────────────────────────────────────
app.get('/admin',      (_req, res) => res.redirect(301, 'https://wispplay.com/admin'));
app.get('/admin.html', (_req, res) => res.redirect(301, 'https://wispplay.com/admin'));

app.get('/api/admin/stats', adminAuth, (_req, res) => {
  res.json({
    users:     stmts.statsUsers.get(),
    purchases: stmts.statsPurchases.get(),
  });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : null;
  res.json(q ? stmts.searchUsers.all({ q }) : stmts.listUsers.all());
});

app.post('/api/admin/users/:id/mushrooms', adminAuth, (req, res) => {
  const id   = parseInt(req.params.id);
  const user = stmts.getUserById.get(id);
  if (!user) return res.status(404).json({ error: 'Użytkownik nie istnieje' });
  const { mushrooms, delta } = req.body;
  let newVal;
  if (typeof delta === 'number') newVal = Math.max(0, user.mushrooms + delta);
  else if (typeof mushrooms === 'number') newVal = Math.max(0, mushrooms);
  else return res.status(400).json({ error: 'Podaj mushrooms lub delta' });
  stmts.setMushrooms.run(newVal, id);
  res.json({ ok: true, mushrooms: newVal });
});

app.delete('/api/admin/users/:id', adminAuth, (req, res) => {
  stmts.deleteUser.run(parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('/api/admin/purchases', adminAuth, (_req, res) => {
  res.json(stmts.recentPurchases.all());
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'allow',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

// ─── Passport Google OAuth ─────────────────────────────────────────────────
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID:     GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL:  `${BASE_URL}/auth/google/callback`,
    },
    (_accessToken, _refreshToken, profile, done) => {
      const email     = profile.emails?.[0]?.value || null;
      const nick      = profile.displayName || email?.split('@')[0] || 'Gracz';
      const avatarUrl = profile.photos?.[0]?.value || null;
      try {
        const user = stmts.upsertUser.get({ google_id: profile.id, email, nick, avatar_url: avatarUrl });
        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  ));
}

// ─── Middleware ─────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Forest Cards Admin"');
    return res.status(401).send('Unauthorized');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const colon   = decoded.indexOf(':');
  const user    = decoded.slice(0, colon);
  const pass    = decoded.slice(colon + 1);
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Forest Cards Admin"');
  res.status(401).send('Unauthorized');
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Brak tokenu autoryzacji' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token nieprawidłowy lub wygasły' });
  }
}

// Rate limit dla gości (per IP, 10/h)
const guestRateMap = new Map();
function guestRateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  const entry = guestRateMap.get(ip);
  if (!entry || entry.resetAt < now) {
    guestRateMap.set(ip, { count: 1, resetAt: now + 3_600_000 });
    return next();
  }
  if (entry.count >= 10) return res.status(429).json({ error: 'Zbyt wiele zgłoszeń — spróbuj za godzinę' });
  entry.count++;
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of guestRateMap) { if (e.resetAt < now) guestRateMap.delete(ip); }
}, 3_600_000);

// ─── Auth Routes ───────────────────────────────────────────────────────────
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: '/?auth=error' }),
  (req, res) => {
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email, nick: req.user.nick },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.redirect(`/?token=${token}`);
  }
);

app.get('/auth/me', requireAuth, (req, res) => {
  const user = stmts.getUserById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Użytkownik nie istnieje' });
  const { google_id, ...safe } = user;
  res.json(safe);
});

app.post('/auth/logout', requireAuth, (_req, res) => res.json({ ok: true }));

app.delete('/api/account', requireAuth, (req, res) => {
  stmts.deleteUser.run(req.user.id);
  res.json({ ok: true });
});

app.post('/api/account/nick', requireAuth, (req, res) => {
  const raw = typeof req.body.nick === 'string' ? req.body.nick.trim() : '';
  if (!raw)           return res.status(400).json({ error: 'Nick nie może być pusty' });
  if (raw.length > 20) return res.status(400).json({ error: 'Nick max 20 znaków' });
  db.prepare('UPDATE users SET nick=? WHERE id=?').run(raw, req.user.id);
  res.json({ ok: true, nick: raw });
});

// ─── Progress Sync ──────────────────────────────────────────────────────────
app.get('/api/progress', requireAuth, (req, res) => {
  const user = stmts.getUserById.get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Użytkownik nie istnieje' });
  let collection = [];
  try { collection = JSON.parse(user.collection || '[]'); } catch {}
  res.json({
    mushrooms:    user.mushrooms,
    wins:         user.wins,
    battle_level: user.battle_level,
    score:        user.score,
    collection,
    progress_ts:  user.progress_ts || 0,
  });
});

app.post('/api/progress', requireAuth, (req, res) => {
  const { mushrooms, wins, battle_level, score, collection, ts, reset } = req.body;
  if (typeof wins !== 'number' || typeof score !== 'number') {
    return res.status(400).json({ error: 'Nieprawidłowe dane' });
  }
  const progressTs   = typeof ts === 'number' ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000);
  const collectionJs = JSON.stringify(Array.isArray(collection) ? collection : []);
  const stmt         = reset ? stmts.resetProgress : stmts.saveProgress;
  stmt.run(
    Math.max(0, mushrooms ?? 0),
    Math.max(0, wins),
    Math.max(1, battle_level ?? 1),
    Math.max(0, score),
    collectionJs,
    progressTs,
    req.user.id
  );
  console.log(`📊 progress uid=${req.user.id} wins=${wins} mushrooms=${mushrooms}`);
  res.json({ ok: true });
});

// ─── Scores & Leaderboard ───────────────────────────────────────────────────
app.post('/api/score/guest', guestRateLimit, (req, res) => {
  const { nick, score, wins, battle_level, device_id } = req.body;
  if (typeof score !== 'number' || score < 0)   return res.status(400).json({ error: 'Nieprawidłowy wynik' });
  if (typeof wins  !== 'number' || wins  < 0)   return res.status(400).json({ error: 'Nieprawidłowe wins' });
  const name   = (typeof nick      === 'string' ? nick.trim().slice(0, 20) : '') || 'Gość';
  const devId  = (typeof device_id === 'string' && device_id.length >= 8) ? device_id.slice(0, 64) : null;
  const sc     = Math.floor(score);
  const w      = Math.max(0, Math.floor(wins));
  const bl     = Math.max(1, Math.floor(battle_level ?? 1));

  if (devId) {
    const existing = db.prepare('SELECT id, score FROM scores WHERE device_id = ? AND user_id IS NULL').get(devId);
    if (existing) {
      if (sc > existing.score) {
        db.prepare('UPDATE scores SET guest_nick=?, score=?, wins=?, battle_level=? WHERE id=?').run(name, sc, w, bl, existing.id);
      } else {
        db.prepare('UPDATE scores SET guest_nick=? WHERE id=?').run(name, existing.id);
      }
    } else {
      stmts.insertGuestScore.run(name, sc, w, bl, devId);
    }
  } else {
    stmts.insertGuestScore.run(name, sc, w, bl, null);
  }
  res.json({ ok: true });
});

app.post('/api/score', requireAuth, (req, res) => {
  const { score, wins, battle_level } = req.body;
  if (typeof score !== 'number') return res.status(400).json({ error: 'Nieprawidłowe dane' });
  const userId = req.user.id;
  const user   = stmts.getUserById.get(userId);
  if (!user) return res.status(404).json({ error: 'Użytkownik nie istnieje' });
  stmts.insertScore.run(userId, Math.floor(score), Math.max(0, wins ?? 0), Math.max(1, battle_level ?? 1));
  if (score > (user.score || 0)) {
    db.prepare('UPDATE users SET score=?, wins=MAX(wins,?), battle_level=MAX(battle_level,?) WHERE id=?')
      .run(Math.floor(score), Math.max(0, wins ?? 0), Math.max(1, battle_level ?? 1), userId);
  }
  res.json({ ok: true, score });
});

app.get('/api/leaderboard', (_req, res) => {
  res.json(stmts.topScores.all());
});

// ─── Paddle Routes ──────────────────────────────────────────────────────────
app.post('/api/buy', requireAuth, (req, res) => {
  if (!paddle) return res.status(503).json({ error: 'Płatności tymczasowo niedostępne' });
  const pkg = PACKAGES[req.body.package_id];
  if (!pkg)  return res.status(400).json({ error: 'Nieznany pakiet' });
  res.json({
    price_id:   pkg.price_id,
    user_id:    req.user.id,
    package_id: req.body.package_id,
    mushrooms:  pkg.mushrooms,
  });
});

async function handlePaddleWebhook(req, res) {
  console.log('📦 Paddle webhook');
  if (!PADDLE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook nie skonfigurowany' });

  const sig = req.headers['paddle-signature'];
  if (!sig) return res.status(400).json({ error: 'Brak podpisu' });
  try {
    const [tsPart, h1Part] = sig.split(';');
    const ts   = tsPart.split('=')[1];
    const h1   = h1Part.split('=')[1];
    const body = req.body.toString();
    const computed = require('crypto').createHmac('sha256', PADDLE_WEBHOOK_SECRET)
      .update(`${ts}:${body}`).digest('hex');
    if (computed !== h1) {
      console.error('Paddle webhook: nieprawidłowy podpis');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  let event;
  try { event = JSON.parse(req.body.toString()); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (event.event_type === 'transaction.completed') {
    const txn        = event.data;
    const customData = txn.custom_data || {};
    try {
      const userId = parseInt(customData.user_id);
      const pkgId  = customData.package_id;
      const pkg    = PACKAGES[pkgId];
      if (!userId || !pkg) {
        console.error('Paddle webhook: brak user_id lub package_id', customData);
        return res.json({ received: true });
      }
      const result = stmts.insertPurchase.run({
        user_id:       userId,
        paddle_txn_id: txn.id,
        package_id:    pkgId,
        mushrooms:     pkg.mushrooms,
        amount_eur_ct: pkg.amount,
      });
      if (result.changes > 0) {
        if(pkg.mushrooms > 0) stmts.addMushrooms.run(pkg.mushrooms, userId);
        console.log(`✅ uid=${userId} grzyby=${pkg.mushrooms} zycia=${pkg.lives||0} (txn: ${txn.id})`);
      } else {
        console.log(`ℹ️  Duplikat transakcji zignorowany: ${txn.id}`);
      }
    } catch (err) {
      console.error('DB error przy Paddle webhook:', err.message);
      return res.status(500).json({ error: 'DB error' });
    }
  }
  res.json({ received: true });
}

// ─── Google Play Billing ─────────────────────────────────────────────────────
const GP_PACKAGE  = 'com.epro.forestcards';
const GP_KEY_FILE = path.join(__dirname, 'forestcards-service-account.json');

async function getAndroidPublisher() {
  const auth = new google.auth.GoogleAuth({
    keyFile: GP_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  return google.androidpublisher({ version: 'v3', auth });
}

app.post('/api/gplay/verify', requireAuth, async (req, res) => {
  const { package_id, purchase_token } = req.body;
  const pkg = PACKAGES[package_id];
  if (!pkg || !purchase_token) return res.status(400).json({ error: 'Nieprawidłowe dane' });
  try {
    const publisher = await getAndroidPublisher();
    const result    = await publisher.purchases.products.get({
      packageName: GP_PACKAGE,
      productId:   package_id,
      token:       purchase_token,
    });
    const purchase = result.data;
    if (purchase.purchaseState !== 0) return res.status(400).json({ error: 'Zakup nieważny' });
    if (stmts.getPurchaseByToken.get(purchase_token)) return res.status(409).json({ error: 'Token już wykorzystany' });
    stmts.insertPurchase.run({
      user_id:       req.user.id,
      paddle_txn_id: purchase_token,
      package_id,
      mushrooms:     pkg.mushrooms,
      amount_eur_ct: pkg.amount,
    });
    if(pkg.mushrooms > 0) stmts.addMushrooms.run(pkg.mushrooms, req.user.id);
    const isLivesPkg = pkg.lives > 0;
    console.log(`✅ [GP] uid=${req.user.id} pkg=${package_id} grzyby=${pkg.mushrooms} zycia=${pkg.lives}`);
    await publisher.purchases.products.consume({
      packageName: GP_PACKAGE,
      productId:   package_id,
      token:       purchase_token,
    });
    const user = stmts.getUserById.get(req.user.id);
    res.json({ ok: true, mushrooms: user.mushrooms, lives: isLivesPkg ? pkg.lives : 0 });
  } catch (err) {
    console.error('❌ [GP] verify error:', err.message);
    res.status(500).json({ error: 'Błąd weryfikacji zakupu' });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', game: 'Forest Cards v1', env: NODE_ENV });
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function purgeStaleAccounts() {
  const r = stmts.purgeOldUsers.run();
  if (r.changes > 0) console.log(`🗑️  Usunięto ${r.changes} nieaktywnych kont (>90 dni)`);
}
purgeStaleAccounts();
setInterval(purgeStaleAccounts, 24 * 60 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🃏 Forest Cards serwer na http://127.0.0.1:${PORT}`);
  console.log(`   BASE_URL: ${BASE_URL}`);
  console.log(`   Paddle: ${paddle ? `✅ (${PADDLE_ENV})` : '⚠️  brak klucza'}`);
  console.log(`   Google OAuth: ${GOOGLE_CLIENT_ID ? '✅' : '⚠️  brak CLIENT_ID'}`);
});
