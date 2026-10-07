const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Optional: Hugging Face token for higher-quality SDXL (free token at huggingface.co/settings/tokens)
const HF_TOKEN = process.env.HF_TOKEN || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Auth — email + password accounts (file-based, users.json)            */
/*                                                                     */
/* Passwords are hashed with PBKDF2 (SHA-512, 120k iterations, unique   */
/* salt per user). Plain passwords are never stored. Sessions are      */
/* random 256-bit bearer tokens stored with the user record.           */
/*                                                                     */
/* HONEST LIMITS (file-based store):                                   */
/* - users.json / usage.json live on the local filesystem. On free     */
/*   hosting (Render free tier) the filesystem is EPHEMERAL — accounts */
/*   and usage reset whenever the service restarts or sleeps.          */
/* - No rate limiting on login/register (production needs it).         */
/* - No email verification (production should verify emails).          */
/* Production path: move users + usage to Supabase Postgres +          */
/* Supabase Auth / Better Auth.                                        */
/* ------------------------------------------------------------------ */

const USERS_FILE = path.join(__dirname, 'users.json');
const PBKDF2_ITER = 120000;
const TOKEN_BYTES = 32;

let userStore = { users: {} };
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (parsed && parsed.users) userStore = parsed;
    }
  } catch (e) { console.log('users.json unreadable, starting fresh'); }
}
loadUsers();
function saveUsers() {
  fs.writeFile(USERS_FILE, JSON.stringify(userStore), (e) => {
    if (e) console.log('users save failed:', e.message);
  });
}

function normEmail(e) { return (e || '').toString().trim().toLowerCase(); }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, s, PBKDF2_ITER, 64, 'sha512').toString('hex');
  return { salt: s, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, 64, 'sha512');
    const expected = Buffer.from(hash, 'hex');
    return h.length === expected.length && crypto.timingSafeEqual(h, expected);
  } catch (e) { return false; }
}
function newToken() { return crypto.randomBytes(TOKEN_BYTES).toString('hex'); }

/** Find user record by bearer token (checks expiry: 30 days). */
function userByToken(token) {
  if (!token) return null;
  for (const email of Object.keys(userStore.users)) {
    const u = userStore.users[email];
    if (u && Array.isArray(u.tokens)) {
      const t = u.tokens.find((x) => x.token === token);
      if (t) {
        if (Date.now() - t.createdAt > 30 * 24 * 3600 * 1000) return null; // expired
        return { email, user: u };
      }
    }
  }
  return null;
}

/** Auth middleware. Sets req.authEmail or 401s. */
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const m = hdr.match(/^Bearer\s+(\S+)$/i);
  const found = m && userByToken(m[1]);
  if (!found) {
    return res.status(401).json({ error: 'Please sign in first.', code: 'auth_required' });
  }
  req.authEmail = found.email;
  next();
}

/* ------------------------------------------------------------------ */
/* Simple math CAPTCHA (anti-bot for login/register)                    */
/*                                                                     */
/* GET /api/captcha -> { id, question }. The client must send           */
/* { captchaId, captchaAnswer } with /api/login and /api/register.      */
/* Captchas are one-time use and expire after 5 minutes. In-memory      */
/* (ephemeral on free hosting — fine for a bot-speed-bump).             */
/* ------------------------------------------------------------------ */
const captchaStore = {};
const CAPTCHA_TTL_MS = 5 * 60 * 1000;

function newCaptcha() {
  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const variants = [
    { q: a + ' + ' + b, a: a + b },
    { q: a + ' × ' + b, a: a * b },
    { q: (a + b) + ' − ' + a, a: b },
  ];
  const pick = variants[Math.floor(Math.random() * variants.length)];
  const id = crypto.randomBytes(8).toString('hex');
  captchaStore[id] = { answer: pick.a, createdAt: Date.now() };
  // prune expired entries
  const now = Date.now();
  for (const k of Object.keys(captchaStore)) {
    if (now - captchaStore[k].createdAt > CAPTCHA_TTL_MS) delete captchaStore[k];
  }
  return { id, question: pick.q };
}

function verifyCaptcha(id, answer) {
  const rec = id && captchaStore[id];
  if (!rec) return false;
  delete captchaStore[id]; // one-time use
  if (Date.now() - rec.createdAt > CAPTCHA_TTL_MS) return false;
  return parseInt(answer, 10) === rec.answer;
}

function checkCaptcha(req) {
  const body = req.body || {};
  return verifyCaptcha(body.captchaId, body.captchaAnswer);
}

app.get('/api/captcha', (req, res) => {
  res.json(newCaptcha());
});

/**
 * POST /api/register  { email, password }
 * Creates an account, returns { token, email }.
 */
app.post('/api/register', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = (req.body && req.body.password || '').toString();
  if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!checkCaptcha(req)) return res.status(400).json({ error: 'Incorrect security answer. Please try again.', code: 'captcha_failed' });
  if (userStore.users[email]) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
  const { salt, hash } = hashPassword(password);
  const token = newToken();
  userStore.users[email] = {
    salt,
    hash,
    createdAt: new Date().toISOString(),
    tokens: [{ token, createdAt: Date.now() }],
  };
  saveUsers();
  res.status(201).json({ token, email, credits: creditsFor(email) });
});

/**
 * POST /api/login  { email, password }
 * Verifies credentials, returns a fresh { token, email }.
 */
app.post('/api/login', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = (req.body && req.body.password || '').toString();
  if (!checkCaptcha(req)) return res.status(400).json({ error: 'Incorrect security answer. Please try again.', code: 'captcha_failed' });
  const u = userStore.users[email];
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = newToken();
  u.tokens = (u.tokens || []).concat([{ token, createdAt: Date.now() }]).slice(-5); // keep last 5 sessions
  saveUsers();
  res.json({ token, email, credits: creditsFor(email) });
});

/**
 * POST /api/logout  (Authorization: Bearer <token>)
 * Invalidates the current session token.
 */
app.post('/api/logout', requireAuth, (req, res) => {
  const u = userStore.users[req.authEmail];
  const hdr = req.headers.authorization || '';
  const token = (hdr.match(/^Bearer\s+(\S+)$/i) || [])[1];
  if (u && token) {
    u.tokens = (u.tokens || []).filter((x) => x.token !== token);
    saveUsers();
  }
  res.json({ ok: true });
});

/**
 * POST /api/change-password  { currentPassword, newPassword }
 * (Authorization: Bearer <token>)
 * Verifies the current password, sets the new one (min 6 chars),
 * and invalidates all OTHER sessions for security.
 */
app.post('/api/change-password', requireAuth, (req, res) => {
  const email = req.authEmail;
  const u = userStore.users[email];
  const currentPassword = (req.body && req.body.currentPassword || '').toString();
  const newPassword = (req.body && req.body.newPassword || '').toString();
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  if (!verifyPassword(currentPassword, u.salt, u.hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'New password must be different from the current one.' });
  }
  const { salt, hash } = hashPassword(newPassword);
  u.salt = salt;
  u.hash = hash;
  // Keep only the current session, revoke all others for safety.
  const hdr = req.headers.authorization || '';
  const token = (hdr.match(/^Bearer\s+(\S+)$/i) || [])[1];
  u.tokens = (u.tokens || []).filter((x) => x.token === token);
  saveUsers();
  res.json({ ok: true, message: 'Password changed successfully.' });
});

/**
 * DELETE /api/account  { password }
 * (Authorization: Bearer <token>)
 * Permanently deletes the account and its usage history.
 * Requires the password as confirmation.
 */
app.delete('/api/account', requireAuth, (req, res) => {
  const email = req.authEmail;
  const u = userStore.users[email];
  const password = (req.body && req.body.password || '').toString();
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  if (!verifyPassword(password, u.salt, u.hash)) {
    return res.status(401).json({ error: 'Password is incorrect. Account was not deleted.' });
  }
  delete userStore.users[email];
  if (usageStore.users && usageStore.users[email]) delete usageStore.users[email];
  saveUsers();
  saveUsage();
  res.json({ ok: true, message: 'Your account has been permanently deleted.' });
});

/** GET /api/me (Authorization: Bearer <token>) -> { email, limits, used, remaining, ads } */
app.get('/api/me', requireAuth, (req, res) => {
  res.json(creditsFor(req.authEmail));
});

/* ------------------------------------------------------------------ */
/* Daily limits + rewarded ads                                          */
/*                                                                     */
/* Usage is tracked per account (email) in usage.json.                 */
/* HONEST LIMIT: free hosting (Render free tier) has an EPHEMERAL       */
/* filesystem — usage.json resets whenever the service restarts or     */
/* sleeps. Real production needs a database (Supabase Postgres).        */
/* ------------------------------------------------------------------ */

const DAILY_IMAGE_LIMIT = 6;
const DAILY_VIDEO_LIMIT = 3;
const USAGE_FILE = path.join(__dirname, 'usage.json');

/* ------------------------------------------------------------------ */
/* Rewarded ads (simulated for now)                                     */
/*                                                                     */
/* AD_PROVIDER = "simulated" | "adsterra"                               */
/* "simulated": frontend shows a 30s countdown, then calls              */
/*   POST /api/watch-ad-complete.                                       */
/* "adsterra": frontend must load Adsterra's rewarded-ad unit (see     */
/*   ADSTERRA_PLACEHOLDER comment in public/index.html) and call       */
/*   /api/watch-ad-complete ONLY after the provider's server-side      */
/*   postback verifies the completed view (anti-fraud).                 */
/* ------------------------------------------------------------------ */
const AD_PROVIDER = process.env.AD_PROVIDER || 'simulated';
const MAX_ADS_PER_DAY = 5;      // max rewarded-ad watches per user per day
const AD_REWARD_IMAGES = 2;     // +images per completed ad watch
const AD_REWARD_VIDEOS = 1;     // +videos per completed ad watch

let usageStore = { users: {} };
try {
  if (fs.existsSync(USAGE_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (parsed && parsed.users) usageStore = parsed;
  }
} catch (e) { console.log('usage.json unreadable, starting fresh'); }

function saveUsage() {
  fs.writeFile(USAGE_FILE, JSON.stringify(usageStore), (e) => {
    if (e) console.log('usage save failed:', e.message);
  });
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

/** Usage record keyed by email (stable account identity). */
function getUsage(email) {
  const today = todayStr();
  let rec = usageStore.users[email];
  if (!rec || rec.date !== today) {
    rec = { date: today, images: 0, videos: 0, ads: 0, bonusImages: 0, bonusVideos: 0 };
    usageStore.users[email] = rec;
  }
  return rec;
}

/** Check the limit WITHOUT recording. Returns {ok} or {ok:false,status,message}. */
function checkLimit(email, type) {
  const rec = getUsage(email);
  const baseLimit = type === 'image' ? DAILY_IMAGE_LIMIT : DAILY_VIDEO_LIMIT;
  const bonus = type === 'image' ? (rec.bonusImages || 0) : (rec.bonusVideos || 0);
  const limit = baseLimit + bonus;
  const used = type === 'image' ? rec.images : rec.videos;
  if (used >= limit) {
    return {
      ok: false,
      status: 429,
      message: `Daily ${type} limit reached (${used}/${limit}). Watch an ad to earn extra credits, or try again tomorrow.`,
    };
  }
  return { ok: true };
}

/** Record one generation after it succeeded. */
function recordUsage(email, type) {
  const rec = getUsage(email);
  if (type === 'image') rec.images++; else rec.videos++;
  saveUsage();
  const totalImages = DAILY_IMAGE_LIMIT + (rec.bonusImages || 0);
  const totalVideos = DAILY_VIDEO_LIMIT + (rec.bonusVideos || 0);
  return {
    images: Math.max(0, totalImages - rec.images),
    videos: Math.max(0, totalVideos - rec.videos),
    totalImages,
    totalVideos,
  };
}

/** Credits snapshot for an account (no recording). */
function creditsFor(email) {
  const rec = getUsage(email);
  const bonusImages = rec.bonusImages || 0;
  const bonusVideos = rec.bonusVideos || 0;
  const totalImages = DAILY_IMAGE_LIMIT + bonusImages;
  const totalVideos = DAILY_VIDEO_LIMIT + bonusVideos;
  return {
    email,
    limits: { images: DAILY_IMAGE_LIMIT, videos: DAILY_VIDEO_LIMIT },
    totals: { images: totalImages, videos: totalVideos },
    bonus: { images: bonusImages, videos: bonusVideos },
    used: { images: rec.images, videos: rec.videos },
    remaining: {
      images: Math.max(0, totalImages - rec.images),
      videos: Math.max(0, totalVideos - rec.videos),
    },
    ads: {
      watched: rec.ads || 0,
      max: MAX_ADS_PER_DAY,
      rewardImages: AD_REWARD_IMAGES,
      rewardVideos: AD_REWARD_VIDEOS,
    },
    adProvider: AD_PROVIDER,
  };
}

/**
 * POST /api/watch-ad-complete — award ad credits after a completed ad view.
 * (Authorization: Bearer <token>)
 * Simulated mode: frontend calls this after its 30s countdown.
 * Adsterra mode: call ONLY after server-side postback verifies the view.
 */
app.post('/api/watch-ad-complete', requireAuth, (req, res) => {
  const email = req.authEmail;
  const rec = getUsage(email);
  rec.ads = rec.ads || 0;
  if (rec.ads >= MAX_ADS_PER_DAY) {
    return res.status(429).json({ error: `You have watched all ${MAX_ADS_PER_DAY} ads for today. Try again tomorrow.` });
  }
  rec.ads++;
  rec.bonusImages = (rec.bonusImages || 0) + AD_REWARD_IMAGES;
  rec.bonusVideos = (rec.bonusVideos || 0) + AD_REWARD_VIDEOS;
  saveUsage();
  res.json({
    message: `Congratulations! +${AD_REWARD_IMAGES} images, +${AD_REWARD_VIDEOS} video credits earned!`,
    adsWatched: rec.ads,
    adsMax: MAX_ADS_PER_DAY,
    credits: creditsFor(email),
  });
});

/**
 * GET /api/generate-image?prompt=...&width=...&height=...
 * (Authorization: Bearer <token>)
 * Primary: Pollinations.ai (free, no key required)
 * Fallback: Hugging Face Inference router (needs HF_TOKEN)
 */
app.get('/api/generate-image', requireAuth, (req, res) => {
  const prompt = (req.query.prompt || '').toString().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // Daily limit check (recorded only after the provider returns 200)
  const gate = checkLimit(req.authEmail, 'image');
  if (!gate.ok) return res.status(gate.status).json({ error: gate.message });

  const width = Math.min(parseInt(req.query.width) || 512, 1024);
  const height = Math.min(parseInt(req.query.height) || 512, 1024);
  const seed = parseInt(req.query.seed) || Math.floor(Math.random() * 999999);

  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=flux`;

  // Stream the image straight through to the client
  https.get(url, { timeout: 120000 }, (imgRes) => {
    if (imgRes.statusCode !== 200) {
      // Try Hugging Face fallback if token is configured
      if (HF_TOKEN) return generateViaHF(prompt, res, req.authEmail);
      return res.status(502).json({ error: 'image provider returned ' + imgRes.statusCode });
    }
    const left = recordUsage(req.authEmail, 'image');
    res.setHeader('X-Images-Left', left.images);
    res.setHeader('X-Videos-Left', left.videos);
    res.setHeader('X-Images-Total', left.totalImages);
    res.setHeader('X-Videos-Total', left.totalVideos);
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  }).on('error', (e) => {
    if (HF_TOKEN) return generateViaHF(prompt, res, req.authEmail);
    res.status(502).json({ error: 'image provider unreachable: ' + e.message });
  });
});

/** Fallback: Hugging Face Inference router (SDXL). Needs HF_TOKEN env var. */
function generateViaHF(prompt, res, email) {
  const body = JSON.stringify({ inputs: prompt });
  const req = https.request({
    hostname: 'router.huggingface.co',
    path: '/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HF_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 120000,
  }, (hfRes) => {
    if (hfRes.statusCode !== 200) {
      let data = '';
      hfRes.on('data', (c) => (data += c));
      hfRes.on('end', () => res.status(502).json({ error: 'HF error ' + hfRes.statusCode, detail: data.slice(0, 300) }));
      return;
    }
    const left = recordUsage(email, 'image');
    res.setHeader('X-Images-Left', left.images);
    res.setHeader('X-Videos-Left', left.videos);
    res.setHeader('X-Images-Total', left.totalImages);
    res.setHeader('X-Videos-Total', left.totalVideos);
    res.setHeader('Content-Type', hfRes.headers['content-type'] || 'image/jpeg');
    hfRes.pipe(res);
  });
  req.on('error', (e) => res.status(502).json({ error: 'HF unreachable: ' + e.message }));
  req.on('timeout', () => { req.destroy(); res.status(504).json({ error: 'HF timeout' }); });
  req.write(body);
  req.end();
}

app.get('/api/health', (req, res) => res.json({
  ok: true,
  hfFallback: !!HF_TOKEN,
  video: true,
  auth: true,
  adProvider: AD_PROVIDER,
  adsPerDay: MAX_ADS_PER_DAY,
  adReward: { images: AD_REWARD_IMAGES, videos: AD_REWARD_VIDEOS },
}));

/* ------------------------------------------------------------------ */
/* FREE video generation                                                */
/*                                                                     */
/* Honest design: there is no keyless, truly-free text-to-video AI API. */
/* pollinations.ai has no video endpoint; HF video models are not on   */
/* the serverless Inference API (they need paid Endpoints/GPU). So the  */
/* free path is: generate an AI still (pollinations, keyless) then     */
/* animate it into a real MP4 with ffmpeg (Ken Burns zoom/pan).        */
/* If HF_TOKEN is set we *try* a true AI video model first and fall    */
/* back to animation on any failure.                                   */
/* ------------------------------------------------------------------ */

const VIDEO_OUT = 720;          // output resolution (square)
const VIDEO_FPS = 25;
const MAX_VIDEO_SEC = 8;

function tmpName(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
}
function safeUnlink(p) {
  if (!p) return;
  fs.unlink(p, () => {});
}

/** Download a URL to a temp file. Resolves with the temp path. */
function downloadToTemp(url, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const tmp = tmpName('aas-img', 'jpg');
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        file.close(() => safeUnlink(tmp));
        return reject(new Error('image provider returned ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(tmp)));
    });
    req.on('timeout', () => { req.destroy(); file.close(() => safeUnlink(tmp)); reject(new Error('image download timeout')); });
    req.on('error', (e) => { file.close(() => safeUnlink(tmp)); reject(e); });
  });
}

/** ffmpeg zoompan filter for a motion style. frames = total output frames. */
function motionFilter(motion, frames) {
  const S = VIDEO_OUT;
  const base = 'scale=1536:1536';
  const xy = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  switch (motion) {
    case 'zoomout':
      return `${base},zoompan=z='max(1.5-0.002*on,1.0)':d=${frames}:${xy}:s=${S}x${S}:fps=${VIDEO_FPS}`;
    case 'panleft':
      return `${base},zoompan=z=1.4:d=${frames}:x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':s=${S}x${S}:fps=${VIDEO_FPS}`;
    case 'panright':
      return `${base},zoompan=z=1.4:d=${frames}:x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':s=${S}x${S}:fps=${VIDEO_FPS}`;
    case 'zoomin':
    default:
      return `${base},zoompan=z='min(1.0+0.002*on,1.5)':d=${frames}:${xy}:s=${S}x${S}:fps=${VIDEO_FPS}`;
  }
}

function runFfmpeg(imgPath, vidPath, vf, frames) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-v', 'error', '-i', imgPath,
      '-vf', vf, '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', vidPath];
    const p = spawn('ffmpeg', args, { timeout: 180000 });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg exited ' + code + ': ' + err.slice(0, 200)));
    });
  });
}

/** Best-effort: try a true AI video model on HF (needs HF_TOKEN). Resolves video bytes or null. */
function tryHFVideo(prompt) {
  return new Promise((resolve) => {
    if (!HF_TOKEN) return resolve(null);
    const body = JSON.stringify({ inputs: prompt });
    const req = https.request({
      hostname: 'router.huggingface.co',
      path: '/hf-inference/models/damo-vilab/text-to-video-ms-1.7b',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 90000,
    }, (res) => {
      const ct = (res.headers['content-type'] || '').toLowerCase();
      if (res.statusCode !== 200 || !ct.startsWith('video/')) {
        res.resume(); // drain
        return resolve(null); // model unsupported -> fall back to animation
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

/**
 * GET /api/generate-video?prompt=...&duration=5&motion=zoomin&seed=...
 * (Authorization: Bearer <token>)
 * duration: 3–8 seconds (default 5). motion: zoomin|zoomout|panleft|panright.
 * Streams back an MP4 (720x720, 25fps, h264).
 */
app.get('/api/generate-video', requireAuth, async (req, res) => {
  const prompt = (req.query.prompt || '').toString().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // Daily limit check (recorded only after a video is produced)
  const gate = checkLimit(req.authEmail, 'video');
  if (!gate.ok) return res.status(gate.status).json({ error: gate.message });

  const duration = Math.min(Math.max(parseInt(req.query.duration) || 5, 3), MAX_VIDEO_SEC);
  const motion = ['zoomin', 'zoomout', 'panleft', 'panright'].includes(req.query.motion)
    ? req.query.motion : 'zoomin';
  const seed = parseInt(req.query.seed) || Math.floor(Math.random() * 999999);
  const frames = duration * VIDEO_FPS;

  // Optional: true AI video via HF (usually unavailable on serverless -> null)
  try {
    const hfVideo = await tryHFVideo(prompt);
    if (hfVideo && hfVideo.length > 10000) {
      const left = recordUsage(req.authEmail, 'video');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-Video-Source', 'huggingface');
      res.setHeader('X-Images-Left', left.images);
      res.setHeader('X-Videos-Left', left.videos);
      res.setHeader('X-Images-Total', left.totalImages);
      res.setHeader('X-Videos-Total', left.totalVideos);
      return res.send(hfVideo);
    }
  } catch (e) { /* fall through to animation */ }

  // Free path: AI still -> ffmpeg Ken Burns animation
  const imgUrl =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=768&height=768&seed=${seed}&nologo=true&model=flux`;
  let imgPath = null, vidPath = null;
  const cleanup = () => { safeUnlink(imgPath); safeUnlink(vidPath); };
  try {
    imgPath = await downloadToTemp(imgUrl);
    vidPath = tmpName('aas-vid', 'mp4');
    await runFfmpeg(imgPath, vidPath, motionFilter(motion, frames), frames);
    const left = recordUsage(req.authEmail, 'video');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="ayaz-ai-studio.mp4"');
    res.setHeader('X-Video-Source', 'animated-still');
    res.setHeader('X-Images-Left', left.images);
    res.setHeader('X-Videos-Left', left.videos);
    res.setHeader('X-Images-Total', left.totalImages);
    res.setHeader('X-Videos-Total', left.totalVideos);
    const rs = fs.createReadStream(vidPath);
    rs.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'failed to read video' }); cleanup(); });
    rs.pipe(res);
    res.on('finish', cleanup);
    res.on('close', cleanup);
  } catch (e) {
    cleanup();
    if (!res.headersSent) res.status(502).json({ error: 'video generation failed: ' + e.message });
  }
});

app.listen(PORT, () => console.log(`Ayaz AI Studio running on http://localhost:${PORT}`));
