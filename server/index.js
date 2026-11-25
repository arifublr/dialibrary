'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const cfg = require('./config');
const { sql, nosql, initIndexes } = require('./db');
const settings = require('./settings');
const A = require('./auth');
const circ = require('./circ');
const { HttpError, wrap } = require('./util');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY || cfg.IS_VERCEL || cfg.IS_RENDER || cfg.PROD) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"],
      baseUri: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
      ...(cfg.PROD ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  hsts: cfg.PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'same-origin' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=()');
  next();
});

app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Slow down a little.' } }));
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(cookieParser());
app.use('/api/admin/import', express.json({ limit: '6mb' }));
app.use('/api', express.json({ limit: '100kb' }));
app.use('/api', A.loadSession, A.csrfGuard);

app.get('/api/public/stats', wrap(async (req, res) => {
  const s = settings.get();
  const titles = (await sql.prepare('SELECT COUNT(*) c FROM biblio').get())?.c || 0;
  const items = (await sql.prepare('SELECT COUNT(*) c FROM items').get())?.c || 0;
  const biblioRows = await sql.prepare(`SELECT subjects FROM biblio`).all();
  const subjects = new Set(biblioRows.flatMap((r) => (r.subjects ? r.subjects.split('|') : []))).size;
  res.json({
    libraryName: s.libraryName, tagline: s.tagline, publicSearch: s.publicSearch,
    currency: s.currency, loanDays: s.loanDays, graceDays: s.graceDays, finePerDay: s.finePerDay, maxFine: s.maxFine,
    titles,
    items,
    subjects,
  });
}));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/opac', require('./routes/opac'));
app.use('/api/me', require('./routes/me'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

const pub = path.join(__dirname, '..', 'public');
app.get('/app', (req, res) => res.sendFile(path.join(pub, 'app.html')));
app.use(express.static(pub, {
  extensions: ['html'], maxAge: '1h',
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

async function bootstrap() {
  await initIndexes();
  await settings.load();

  try {
    const bookCount = (await sql.prepare('SELECT COUNT(*) c FROM biblio').get())?.c || 0;
    if (bookCount === 0) {
      const { seed } = require('./seed');
      await seed({ force: true, quiet: true });
    }
  } catch (e) {
    console.error('Auto-seed error:', e);
  }

  if (!(await nosql.users.countAsync({}))) {
    const pw = crypto.randomBytes(9).toString('base64url') + '7';
    await nosql.users.insertAsync({
      role: 'admin', name: 'Library Admin', username: 'admin', passHash: await A.hashPassword(pw),
      mustChangePassword: true, active: true, passkeys: [], createdAt: new Date().toISOString(),
    });
    console.log('\n  First start: admin account created.\n  username: admin\n  password: ' + pw + '\n  (shown once, you will be asked to change it)\n');
  }
  await circ.sweepHolds();
  if (!cfg.IS_VERCEL) {
    setInterval(() => circ.sweepHolds().catch(console.error), 10 * 60 * 1000).unref();
  }
}

if (require.main === module) {
  bootstrap().then(() => app.listen(cfg.PORT, '0.0.0.0', () => console.log(`  ${settings.get().libraryName} is open on port ${cfg.PORT}`)));
}

console.log(`Your application is running in: http://localhost:${cfg.PORT}`)
module.exports = { app, bootstrap };
