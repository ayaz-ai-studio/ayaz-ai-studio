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

app.use(express.json({ limit: '2mb' })); // 2mb: profile photo uploads go through JSON
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

/* ------------------------------------------------------------------ */
/* Referral program                                                     */
/*                                                                     */
/* Every account gets a unique 8-char referral code. A new user who    */
/* signs up with a valid code gives BOTH parties +5 image and +3       */
/* video bonus credits. Stats live on the user record in users.json.   */
/* Link format: https://ayaz-ai-studio.onrender.com/?ref=CODE          */
/* ------------------------------------------------------------------ */
const REFERRAL_BONUS_IMAGES = 5;
const REFERRAL_BONUS_VIDEOS = 3;

function newReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function uniqueReferralCode() {
  let code = newReferralCode();
  let guard = 0;
  while (guard++ < 50) {
    let taken = false;
    for (const email of Object.keys(userStore.users)) {
      if (userStore.users[email] && userStore.users[email].referralCode === code) { taken = true; break; }
    }
    if (!taken) return code;
    code = newReferralCode();
  }
  return code;
}

function findUserByReferralCode(code) {
  code = (code || '').toString().trim().toUpperCase();
  if (!code) return null;
  for (const email of Object.keys(userStore.users)) {
    const u = userStore.users[email];
    if (u && u.referralCode === code) return email;
  }
  return null;
}

function awardReferralBonus(email) {
  const rec = getUsage(email);
  rec.bonusImages = (rec.bonusImages || 0) + REFERRAL_BONUS_IMAGES;
  rec.bonusVideos = (rec.bonusVideos || 0) + REFERRAL_BONUS_VIDEOS;
  saveUsage();
}

/**
 * GET /api/referrals  (Authorization: Bearer <token>)
 * Returns the user's referral code, link, and stats.
 */
app.get('/api/referrals', requireAuth, (req, res) => {
  const email = req.authEmail;
  const u = userStore.users[email];
  if (!u) return res.status(404).json({ error: 'Account not found.' });
  if (!u.referralCode) {
    u.referralCode = uniqueReferralCode();
    saveUsers();
  }
  const base = (process.env.PUBLIC_URL || 'https://ayaz-ai-studio.onrender.com').replace(/\/$/, '');
  res.json({
    code: u.referralCode,
    link: base + '/?ref=' + u.referralCode,
    totalReferrals: u.referralCount || 0,
    creditsEarned: u.referralEarned || { images: 0, videos: 0 },
    bonus: { images: REFERRAL_BONUS_IMAGES, videos: REFERRAL_BONUS_VIDEOS },
  });
});

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
 * Email verification (demo mode — no SMTP configured yet).
 * A 6-digit code is generated at registration; in production this would be
 * emailed via Gmail/SendGrid. For now the code is returned in the API
 * response and shown in the UI so the flow is fully testable.
 * Referral bonuses are awarded at VERIFICATION time (not registration)
 * so fake/unverified emails can't farm credits.
 */
const VERIFY_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
function newVerifyCode() {
  // crypto-random 6-digit code
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}
// Simple in-memory rate limit for resend-verification: max 5/hour per email
const resendAttempts = {};
function resendAllowed(email) {
  const now = Date.now();
  const arr = (resendAttempts[email] || []).filter((t) => now - t < 3600 * 1000);
  if (arr.length >= 5) return false;
  arr.push(now);
  resendAttempts[email] = arr;
  return true;
}

/**
 * POST /api/register  { email, password, referralCode? }
 * Creates an UNVERIFIED account, returns { email, needsVerification: true, demoCode }.
 * The user must verify via POST /api/verify-email before they can sign in.
 * If a valid referralCode is supplied, it is recorded; bonuses are awarded
 * at verification time.
 */
app.post('/api/register', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = (req.body && req.body.password || '').toString();
  const referralCode = (req.body && req.body.referralCode || '').toString().trim().toUpperCase();
  if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!checkCaptcha(req)) return res.status(400).json({ error: 'Incorrect security answer. Please try again.', code: 'captcha_failed' });
  if (userStore.users[email]) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
  const { salt, hash } = hashPassword(password);
  const myCode = uniqueReferralCode();
  // Resolve referrer (can't refer yourself — the account doesn't exist yet, but guard anyway)
  let referredBy = null;
  if (referralCode) {
    const refEmail = findUserByReferralCode(referralCode);
    if (refEmail && refEmail !== email) referredBy = refEmail;
  }
  const verifyCode = newVerifyCode();
  userStore.users[email] = {
    salt,
    hash,
    createdAt: new Date().toISOString(),
    tokens: [],
    referralCode: myCode,
    referredBy,
    referralCount: 0,
    referralEarned: { images: 0, videos: 0 },
    emailVerified: false,
    verificationCode: verifyCode,
    verificationExpiry: Date.now() + VERIFY_CODE_TTL_MS,
  };
  saveUsers();
  // DEMO MODE: code returned in the response (replace with real email send in production)
  res.status(201).json({ email, needsVerification: true, demoCode: verifyCode });
});

/**
 * POST /api/verify-email  { email, code }
 * Verifies the 6-digit code; on success marks the email verified, awards any
 * pending referral bonus, and returns a session { token, email, credits }.
 */
app.post('/api/verify-email', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const code = (req.body && req.body.code || '').toString().trim();
  const u = userStore.users[email];
  if (!u) return res.status(404).json({ error: 'Account not found. Please register first.' });
  if (u.emailVerified) {
    // Already verified — just issue a fresh session
    const token = newToken();
    u.tokens = (u.tokens || []).concat([{ token, createdAt: Date.now() }]).slice(-5);
    saveUsers();
    return res.json({ token, email, credits: creditsFor(email), alreadyVerified: true });
  }
  if (!u.verificationCode || !u.verificationExpiry || Date.now() > u.verificationExpiry) {
    return res.status(400).json({ error: 'This code has expired. Please request a new one.', code: 'code_expired' });
  }
  if (code !== u.verificationCode) {
    return res.status(400).json({ error: 'Incorrect verification code. Please try again.', code: 'code_invalid' });
  }
  // Success — verify + award pending referral bonus (anti-abuse: only verified emails earn)
  u.emailVerified = true;
  u.verificationCode = null;
  u.verificationExpiry = null;
  let referralApplied = false;
  if (u.referredBy) {
    awardReferralBonus(email);
    awardReferralBonus(u.referredBy);
    const ru = userStore.users[u.referredBy];
    if (ru) {
      ru.referralCount = (ru.referralCount || 0) + 1;
      ru.referralEarned = ru.referralEarned || { images: 0, videos: 0 };
      ru.referralEarned.images += REFERRAL_BONUS_IMAGES;
      ru.referralEarned.videos += REFERRAL_BONUS_VIDEOS;
    }
    referralApplied = true;
  }
  const token = newToken();
  u.tokens = (u.tokens || []).concat([{ token, createdAt: Date.now() }]).slice(-5);
  saveUsers();
  const credits = creditsFor(email);
  credits.referralApplied = referralApplied;
  res.json({ token, email, credits });
});

/**
 * POST /api/resend-verification  { email }
 * Issues a fresh 6-digit code (rate-limited: 5/hour per email).
 */
app.post('/api/resend-verification', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const u = userStore.users[email];
  if (!u) return res.status(404).json({ error: 'Account not found. Please register first.' });
  if (u.emailVerified) return res.status(400).json({ error: 'This email is already verified. Please sign in.' });
  if (!resendAllowed(email)) {
    return res.status(429).json({ error: 'Too many requests. Please try again in an hour.' });
  }
  const verifyCode = newVerifyCode();
  u.verificationCode = verifyCode;
  u.verificationExpiry = Date.now() + VERIFY_CODE_TTL_MS;
  saveUsers();
  // DEMO MODE: code returned in the response (replace with real email send in production)
  res.json({ email, demoCode: verifyCode });
});

/**
 * POST /api/login  { email, password }
 * Verifies credentials, returns a fresh { token, email }.
 * Unverified emails get 403 email_not_verified.
 */
app.post('/api/login', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const password = (req.body && req.body.password || '').toString();
  if (!checkCaptcha(req)) return res.status(400).json({ error: 'Incorrect security answer. Please try again.', code: 'captcha_failed' });
  const u = userStore.users[email];
  if (u && u.authProvider === 'google' && !u.hash) {
    return res.status(401).json({ error: 'This account uses Google sign-in. Please use "Continue with Google".', code: 'google_only' });
  }
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (!u.emailVerified) {
    return res.status(403).json({ error: 'Please verify your email before signing in. Check your verification code.', code: 'email_not_verified', email });
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

/* ------------------------------------------------------------------ */
/* Password reset                                                       */
/*                                                                     */
/* POST /api/forgot-password { email } — creates a one-time reset      */
/*   token (30 min expiry). DEMO MODE: the token is returned in the    */
/*   response because no email service is wired yet. Production must   */
/*   email the token link instead of returning it.                     */
/* POST /api/reset-password { token, newPassword } — sets the new      */
/*   password and revokes ALL sessions for safety.                     */
/* Always returns a generic message for unknown emails to avoid        */
/* account enumeration.                                                */
/* ------------------------------------------------------------------ */

/**
 * POST /api/forgot-password  { email }
 */
app.post('/api/forgot-password', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  const generic = { ok: true, message: 'If an account exists for this email, a password reset token has been created.' };
  if (!validEmail(email)) return res.json(generic);
  const u = userStore.users[email];
  if (!u) return res.json(generic);
  const token = newToken();
  u.reset = { token, expires: Date.now() + 30 * 60 * 1000 };
  saveUsers();
  // DEMO: return the token directly (no email service wired yet).
  res.json({
    ok: true,
    message: 'Reset token created. In production this would be emailed to you; demo mode shows it below.',
    demoToken: token,
  });
});

/**
 * POST /api/reset-password  { token, newPassword }
 */
app.post('/api/reset-password', (req, res) => {
  const token = (req.body && req.body.token || '').toString().trim();
  const newPassword = (req.body && req.body.newPassword || '').toString();
  if (!token) return res.status(400).json({ error: 'Reset token is required.' });
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  let targetEmail = null;
  for (const email of Object.keys(userStore.users)) {
    const u = userStore.users[email];
    if (u && u.reset && u.reset.token === token) {
      if (Date.now() > u.reset.expires) {
        delete u.reset;
        saveUsers();
        return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
      }
      targetEmail = email;
      break;
    }
  }
  if (!targetEmail) return res.status(400).json({ error: 'Invalid reset token.' });
  const u = userStore.users[targetEmail];
  const { salt, hash } = hashPassword(newPassword);
  u.salt = salt;
  u.hash = hash;
  delete u.reset;
  u.tokens = []; // revoke all sessions for safety
  saveUsers();
  res.json({ ok: true, message: 'Password reset successfully. Please sign in with your new password.' });
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
  if (creationsStore.users && creationsStore.users[email]) delete creationsStore.users[email];
  if (feedbackStore.entries) {
    feedbackStore.entries = feedbackStore.entries.filter((e) => e.email !== email);
  }
  saveUsers();
  saveUsage();
  saveCreations();
  saveFeedback();
  res.json({ ok: true, message: 'Your account has been permanently deleted.' });
});

/** GET /api/me (Authorization: Bearer <token>) -> { email, limits, used, remaining, ads, profile } */
app.get('/api/me', requireAuth, (req, res) => {
  const base = creditsFor(req.authEmail);
  const u = userStore.users[req.authEmail] || {};
  base.profile = {
    displayName: u.displayName || u.googleName || null,
    username: u.username || null,
    photo: u.photo || u.googlePhoto || null,
    emailVerified: !!u.emailVerified,
    // Legacy accounts (field absent) are treated as complete — only brand-new
    // Google signups get profileComplete:false and see the setup screen.
    profileComplete: u.profileComplete !== false,
    authProvider: u.authProvider || 'email',
  };
  res.json(base);
});

/** Case-insensitive username lookup, optionally excluding one email. */
function findUserByUsername(usernameLower, excludeEmail) {
  for (const em of Object.keys(userStore.users || {})) {
    if (excludeEmail && normEmail(em) === normEmail(excludeEmail)) continue;
    const rec = userStore.users[em];
    if (rec && rec.usernameLower === usernameLower) return em;
  }
  return null;
}

/**
 * GET /api/profile/username-available?u=NAME (auth) -> { ok, available }
 * Live availability check used by the profile setup screen.
 */
app.get('/api/profile/username-available', requireAuth, (req, res) => {
  const username = String(req.query.u || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.json({ ok: true, available: false, reason: 'format' });
  }
  const clash = findUserByUsername(username.toLowerCase(), req.authEmail);
  res.json({ ok: true, available: !clash });
});

/**
 * POST /api/profile/setup (auth) { displayName, username, photo? }
 * Saves the new user's profile and marks profileComplete. Photo is an
 * optional data-URL (jpeg/png/webp/gif, ~500KB max after base64).
 */
app.post('/api/profile/setup', requireAuth, (req, res) => {
  const email = req.authEmail;
  const u = userStore.users[email];
  if (!u) return res.status(401).json({ error: 'Please sign in first.', code: 'auth_required' });
  const body = req.body || {};
  const displayName = String(body.displayName || '').trim().slice(0, 40);
  const username = String(body.username || '').trim();
  if (!displayName) return res.status(400).json({ error: 'Please enter your display name.' });
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, _).' });
  }
  const unameLower = username.toLowerCase();
  if (findUserByUsername(unameLower, email)) {
    return res.status(409).json({ error: 'That username is taken. Try another one.' });
  }
  let photo = null;
  if (body.photo) {
    const p = String(body.photo);
    if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(p)) {
      return res.status(400).json({ error: 'Photo must be a JPEG, PNG, WebP or GIF image.' });
    }
    if (p.length > 700000) {
      return res.status(400).json({ error: 'Photo is too large. Please use a smaller image.' });
    }
    photo = p;
  }
  u.displayName = displayName;
  u.username = username;
  u.usernameLower = unameLower;
  if (photo) u.photo = photo;
  u.profileComplete = true;
  saveUsers();
  res.json({
    ok: true,
    profile: {
      displayName,
      username,
      photo: u.photo || u.googlePhoto || null,
      emailVerified: !!u.emailVerified,
      profileComplete: true,
      authProvider: u.authProvider || 'email',
    },
  });
});

/* ------------------------------------------------------------------ */
/* Google OAuth 2.0 login                                               */
/*                                                                     */
/* Real "Continue with Google" sign-in.                                 */
/*                                                                     */
/* Required Render environment variables:                              */
/*   GOOGLE_CLIENT_ID     - OAuth client ID (Google Cloud Console)      */
/*   GOOGLE_CLIENT_SECRET - OAuth client secret (NEVER expose publicly)*/
/* Optional:                                                           */
/*   GOOGLE_REDIRECT_URI  - defaults to the production callback URL    */
/*                                                                     */
/* Flow:                                                               */
/*   1. GET /auth/google[?ref=CODE] -> 302 redirect to Google          */
/*   2. Google redirects back to GET /auth/google/callback?code&state  */
/*   3. Server exchanges the code for tokens (server-to-server),       */
/*      fetches the user's profile from Google, creates/links the      */
/*      local account, issues our own session token, and redirects    */
/*      the browser to /?token=<session> (or /?oauth_error=...).      */
/*                                                                     */
/* Security notes:                                                     */
/* - The client SECRET lives only in this backend process. It is never */
/*   sent to the browser, never logged, and never in any response.     */
/* - `state` is a one-time random CSRF token (10-minute expiry).       */
/* - Google accounts are trusted as email-verified by Google.          */
/* ------------------------------------------------------------------ */

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ||
  '201734170317-golukdkaodb660vudqsk5t06onufpavv.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
// IMPORTANT: Set GOOGLE_CLIENT_SECRET as environment variable on Render.
// Never commit the real secret to GitHub. Get it from Google Cloud Console.
const GOOGLE_REDIRECT_URI = (process.env.GOOGLE_REDIRECT_URI ||
  'https://ayaz-ai-studio.onrender.com/auth/google/callback').replace(/\/$/, '');
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map(); // state -> { createdAt, ref }

function pruneOauthStates() {
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    if (now - v.createdAt > OAUTH_STATE_TTL_MS) oauthStates.delete(k);
  }
}

/** Exchange an OAuth authorization code for tokens (server-to-server). */
function googleExchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'AyazAIStudio/1.0',
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode !== 200 || !j.access_token) {
            return reject(new Error('Token exchange failed: ' +
              (j.error_description || j.error || ('HTTP ' + res.statusCode))));
          }
          resolve(j);
        } catch (e) { reject(new Error('Token exchange: bad response from Google')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Google token request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Fetch the Google profile for an access token (server-to-server). */
function googleUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      timeout: 20000,
      headers: { 'Authorization': 'Bearer ' + accessToken, 'User-Agent': 'AyazAIStudio/1.0' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode !== 200 || !j.email) {
            return reject(new Error('Could not verify Google account'));
          }
          resolve(j);
        } catch (e) { reject(new Error('Bad profile response from Google')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Google profile request timed out')); });
    req.on('error', reject);
  });
}

/**
 * GET /auth/google[?ref=CODE]
 * Starts the Google OAuth flow with a 302 redirect to Google's consent
 * screen. `state` is a one-time CSRF token.
 */
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_SECRET) {
    return res.status(500).send(
      '<h2>Google sign-in is not configured</h2>' +
      '<p>The server is missing the <b>GOOGLE_CLIENT_SECRET</b> environment variable. ' +
      'Set <b>GOOGLE_CLIENT_ID</b> and <b>GOOGLE_CLIENT_SECRET</b> in the hosting ' +
      'dashboard (Render &rarr; Environment), then redeploy.</p>'
    );
  }
  pruneOauthStates();
  // Optional referral passthrough: /auth/google?ref=CODE
  let ref = null;
  const rawRef = (req.query.ref || '').toString().trim().toUpperCase();
  if (rawRef) {
    const refEmail = findUserByReferralCode(rawRef);
    if (refEmail) ref = rawRef;
  }
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { createdAt: Date.now(), ref });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

/**
 * GET /auth/google/callback?code=...&state=...
 * Google redirects here after consent. Validates `state`, exchanges the
 * code for tokens, verifies the Google profile, creates/links the local
 * account, issues our session token, and redirects to /?token=<session>
 * (or /?oauth_error=<message> on failure).
 */
app.get('/auth/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/?oauth_error=' + encodeURIComponent(msg));
  try {
    if (!GOOGLE_CLIENT_SECRET) return fail('Google sign-in is not configured on the server.');
    const code = (req.query.code || '').toString();
    const state = (req.query.state || '').toString();
    const oauthErr = (req.query.error || '').toString();
    if (oauthErr) {
      const desc = (req.query.error_description || '').toString();
      return fail('Google sign-in was cancelled' + (desc ? ': ' + desc : '') + '.');
    }
    if (!code || !state) return fail('Invalid Google response. Please try again.');
    pruneOauthStates();
    const entry = oauthStates.get(state);
    oauthStates.delete(state); // one-time use
    if (!entry || Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) {
      return fail('Session expired. Please try signing in again.');
    }
    const tokens = await googleExchangeCode(code);
    const profile = await googleUserInfo(tokens.access_token);
    const email = normEmail(profile.email);
    if (!validEmail(email) || profile.email_verified === false) {
      return fail('Google did not provide a verified email address.');
    }
    let u = userStore.users[email];
    let isNew = false;
    if (!u) {
      // Brand-new account via Google: email already verified by Google,
      // no password needed (authProvider marks the sign-in method).
      u = {
        salt: null,
        hash: null,
        authProvider: 'google',
        googleId: profile.sub || null,
        googleName: profile.name || null,
        googlePhoto: profile.picture || null,
        displayName: null,
        username: null,
        usernameLower: null,
        photo: null,
        profileComplete: false, // new Google users finish profile setup in-app
        createdAt: new Date().toISOString(),
        tokens: [],
        referralCode: uniqueReferralCode(),
        referredBy: null,
        referralCount: 0,
        referralEarned: { images: 0, videos: 0 },
        emailVerified: true,
        verificationCode: null,
        verificationExpiry: null,
      };
      // Referral bonus — same deal as verified email signup
      if (entry.ref) {
        const refEmail = findUserByReferralCode(entry.ref);
        if (refEmail && refEmail !== email) {
          u.referredBy = refEmail;
          awardReferralBonus(email);
          awardReferralBonus(refEmail);
          const ru = userStore.users[refEmail];
          if (ru) {
            ru.referralCount = (ru.referralCount || 0) + 1;
            ru.referralEarned = ru.referralEarned || { images: 0, videos: 0 };
            ru.referralEarned.images += REFERRAL_BONUS_IMAGES;
            ru.referralEarned.videos += REFERRAL_BONUS_VIDEOS;
          }
        }
      }
      userStore.users[email] = u;
      isNew = true;
    } else {
      // Existing account — link the Google identity and trust Google's
      // email verification. A previously set password keeps working.
      u.googleId = u.googleId || profile.sub || null;
      u.authProvider = u.authProvider || 'google';
      if (!u.googleName) u.googleName = profile.name || null;
      u.googlePhoto = profile.picture || u.googlePhoto || null;
      if (!u.emailVerified) u.emailVerified = true;
      if (!u.referralCode) u.referralCode = uniqueReferralCode();
      if (!Array.isArray(u.tokens)) u.tokens = [];
    }
    const token = newToken();
    u.tokens = (u.tokens || []).concat([{ token, createdAt: Date.now() }]).slice(-5);
    saveUsers();
    const needSetup = isNew || u.profileComplete === false;
    res.redirect('/?token=' + encodeURIComponent(token) + (isNew ? '&welcome=1' : '') + (needSetup ? '&setup=1' : ''));
  } catch (e) {
    console.log('Google OAuth callback failed:', e.message);
    fail('Google sign-in failed. Please try again.');
  }
});


/* ------------------------------------------------------------------ */
/* Feedback                                                             */
/*                                                                     */
/* POST /api/feedback { rating 1-5, text } — signed-in users can rate   */
/* the service and leave comments. Stored in feedback.json (ephemeral   */
/* on free hosting, same caveat as users/usage).                        */
/* GET /api/feedback — returns the signed-in user's own feedback list   */
/* (newest first). No admin role exists yet, so this is a simple       */
/* per-user view for now.                                               */
/* ------------------------------------------------------------------ */

const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const FEEDBACK_MAX_TOTAL = 2000;

let feedbackStore = { entries: [] };
try {
  if (fs.existsSync(FEEDBACK_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) feedbackStore = parsed;
  }
} catch (e) { console.log('feedback.json unreadable, starting fresh'); }

function saveFeedback() {
  fs.writeFile(FEEDBACK_FILE, JSON.stringify(feedbackStore), (e) => {
    if (e) console.log('feedback save failed:', e.message);
  });
}

/**
 * POST /api/feedback  { rating: 1-5, text }
 * (Authorization: Bearer <token>)
 */
app.post('/api/feedback', requireAuth, (req, res) => {
  const rating = parseInt(req.body && req.body.rating, 10);
  const text = (req.body && req.body.text || '').toString().trim().slice(0, 1000);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please choose a rating from 1 to 5 stars.' });
  }
  if (!text) {
    return res.status(400).json({ error: 'Please write a few words about your experience.' });
  }
  feedbackStore.entries.push({
    email: req.authEmail,
    rating,
    text,
    createdAt: new Date().toISOString(),
  });
  if (feedbackStore.entries.length > FEEDBACK_MAX_TOTAL) {
    feedbackStore.entries = feedbackStore.entries.slice(-FEEDBACK_MAX_TOTAL);
  }
  saveFeedback();
  res.status(201).json({ ok: true, message: 'Thank you for your feedback!' });
});

/**
 * GET /api/feedback  (Authorization: Bearer <token>)
 * Returns the signed-in user's own feedback (newest first).
 */
app.get('/api/feedback', requireAuth, (req, res) => {
  const mine = feedbackStore.entries
    .filter((e) => e.email === req.authEmail)
    .reverse();
  res.json({ feedback: mine });
});

/* ------------------------------------------------------------------ */
/* Newsletter                                                           */
/*                                                                     */
/* POST /api/newsletter { email } — public signup for product updates.  */
/* Stored in newsletter.json (ephemeral on free hosting, same caveat   */
/* as users/usage). Duplicates are ignored.                            */
/* ------------------------------------------------------------------ */

const NEWSLETTER_FILE = path.join(__dirname, 'newsletter.json');
const NEWSLETTER_MAX_TOTAL = 10000;

let newsletterStore = { emails: [] };
try {
  if (fs.existsSync(NEWSLETTER_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(NEWSLETTER_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.emails)) newsletterStore = parsed;
  }
} catch (e) { console.log('newsletter.json unreadable, starting fresh'); }

function saveNewsletter() {
  fs.writeFile(NEWSLETTER_FILE, JSON.stringify(newsletterStore), (e) => {
    if (e) console.log('newsletter save failed:', e.message);
  });
}

/**
 * POST /api/newsletter  { email }
 * Public — no auth required.
 */
app.post('/api/newsletter', (req, res) => {
  const email = normEmail(req.body && req.body.email);
  if (!validEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const exists = newsletterStore.emails.some((e) => e.email === email);
  if (exists) {
    return res.json({ ok: true, message: 'You are already subscribed. Thank you!' });
  }
  newsletterStore.emails.push({ email, createdAt: new Date().toISOString() });
  if (newsletterStore.emails.length > NEWSLETTER_MAX_TOTAL) {
    newsletterStore.emails = newsletterStore.emails.slice(-NEWSLETTER_MAX_TOTAL);
  }
  saveNewsletter();
  res.status(201).json({ ok: true, message: 'Subscribed! Welcome to the Ayaz AI Studio newsletter.' });
});

/* ------------------------------------------------------------------ */
/* My Creations (notebook)                                              */
/*                                                                     */
/* Every successful generation is logged per account in                 */
/* creations.json: { type, prompt, params, createdAt }. The actual      */
/* image/video files are NOT stored (they stream on-demand), so each   */
/* entry offers a "Regenerate" action that re-runs the same prompt.    */
/* Capped at 100 entries per user (oldest dropped). Ephemeral on free  */
/* hosting — production path is Supabase Postgres.                      */
/* ------------------------------------------------------------------ */

const CREATIONS_FILE = path.join(__dirname, 'creations.json');
const CREATIONS_MAX_PER_USER = 100;

let creationsStore = { users: {} };
try {
  if (fs.existsSync(CREATIONS_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(CREATIONS_FILE, 'utf8'));
    if (parsed && parsed.users) creationsStore = parsed;
  }
} catch (e) { console.log('creations.json unreadable, starting fresh'); }

function saveCreations() {
  fs.writeFile(CREATIONS_FILE, JSON.stringify(creationsStore), (e) => {
    if (e) console.log('creations save failed:', e.message);
  });
}

/** Log one successful generation for the notebook. */
function recordCreation(email, type, prompt, params) {
  const list = creationsStore.users[email] || [];
  list.push({
    type,
    prompt: (prompt || '').toString().slice(0, 500),
    params: params || {},
    createdAt: new Date().toISOString(),
  });
  creationsStore.users[email] = list.slice(-CREATIONS_MAX_PER_USER);
  saveCreations();
}

/**
 * GET /api/my-creations  (Authorization: Bearer <token>)
 * Returns the user's generation history, newest first.
 */
app.get('/api/my-creations', requireAuth, (req, res) => {
  const list = (creationsStore.users[req.authEmail] || []).slice().reverse();
  res.json({ creations: list });
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
    recordCreation(req.authEmail, 'image', prompt, { width, height, seed });
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
  chat: true,
  studyMode: true,
  chatDailyLimit: CHAT_DAILY_LIMIT,
  uploads: true,
  auth: true,
  googleOAuth: !!GOOGLE_CLIENT_SECRET,
  passwordReset: true,
  newsletter: true,
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
      recordCreation(req.authEmail, 'video', prompt, { duration, motion, seed, source: 'huggingface' });
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
    recordCreation(req.authEmail, 'video', prompt, { duration, motion, seed, source: 'animated-still' });
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

/* ------------------------------------------------------------------ */
/* Ask tab — chat with free AI (Pollinations text API)                  */
/*                                                                     */
/* POST /api/chat { message, imageId? } — auth required. Proxies to    */
/*   Pollinations (free, no key). Daily limit: 50 messages. History    */
/*   stored per user in chat.json (ephemeral on free hosting, same     */
/*   caveat as users/usage).                                           */
/* GET /api/chat/history — returns the user's chat history.            */
/* DELETE /api/chat/history — clears it.                               */
/* POST /api/upload { image: dataURL, name? } — stores an uploaded     */
/*   image in a temp dir, served at /uploads/<id>. 5MB max. Used as    */
/*   a visual reference in chat and the Imagine tab.                   */
/*                                                                     */
/* Vision: if an image is attached, we try Pollinations' OpenAI-style  */
/* vision endpoint with the image as a data URL (best effort). If it   */
/* fails we fall back to text-only and say so honestly.                */
/* ------------------------------------------------------------------ */

const CHAT_DAILY_LIMIT = 50;
const CHAT_FILE = path.join(__dirname, 'chat.json');
const CHAT_MAX_PER_USER = 100;

let chatStore = { users: {} };
try {
  if (fs.existsSync(CHAT_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    if (parsed && parsed.users) chatStore = parsed;
  }
} catch (e) { console.log('chat.json unreadable, starting fresh'); }

function saveChat() {
  fs.writeFile(CHAT_FILE, JSON.stringify(chatStore), (e) => {
    if (e) console.log('chat save failed:', e.message);
  });
}

function recordChatMessage(email, role, content, imageUrl) {
  const list = chatStore.users[email] || [];
  list.push({ role, content: (content || '').toString().slice(0, 4000), imageUrl: imageUrl || null, createdAt: new Date().toISOString() });
  chatStore.users[email] = list.slice(-CHAT_MAX_PER_USER);
  saveChat();
}

/** Check the chat limit WITHOUT recording. */
function checkChatLimit(email) {
  const rec = getUsage(email);
  const used = rec.chats || 0;
  if (used >= CHAT_DAILY_LIMIT) {
    return { ok: false, status: 429, message: `Daily chat limit reached (${used}/${CHAT_DAILY_LIMIT}). Try again tomorrow.` };
  }
  return { ok: true };
}

function recordChatUsage(email) {
  const rec = getUsage(email);
  rec.chats = (rec.chats || 0) + 1;
  saveUsage();
  return Math.max(0, CHAT_DAILY_LIMIT - rec.chats);
}

/* ------------------------------------------------------------------ */
/* Pollinations text — resilient client                                     */
/*                                                                         */
/* Strategy:                                                               */
/*  1. GET retries (up to 3) with exponential backoff (1s, 2s, 4s)          */
/*  2. Fail fast on 4xx client errors (except 429 which is retried)        */
/*  3. Fallback: POST to /openai endpoint (different server code path)     */
/*  4. Rotating User-Agents to reduce IP/UA-based throttling               */
/* ------------------------------------------------------------------ */

const AI_UA_POOL = [
  'AyazAIStudio/2.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];
function pickAIUA() { return AI_UA_POOL[Math.floor(Math.random() * AI_UA_POOL.length)]; }

function aiSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Classify an AI failure so the API can return honest, specific messages. */
function classifyAIError(err) {
  const msg = String((err && err.message) || err || '');
  if (/timed?\s?out/i.test(msg))
    return { kind: 'timeout', httpStatus: 504, userMessage: 'The AI took too long to respond. Please try again.' };
  if (/(^|\D)429(\D|$)|rate.?limit/i.test(msg))
    return { kind: 'ratelimit', httpStatus: 429, userMessage: 'Too many requests right now. Please wait a few seconds and try again.' };
  if (/empty AI response/i.test(msg))
    return { kind: 'empty', httpStatus: 502, userMessage: 'The AI returned an empty response. Please try again.' };
  return { kind: 'server', httpStatus: 502, userMessage: 'The AI service is having trouble right now. Please try again in a moment.' };
}

/* Single GET attempt against text.pollinations.ai/<prompt>. */
function pollinationsGetOnce(prompt, timeoutMs, ua) {
  return new Promise((resolve, reject) => {
    const url = 'https://text.pollinations.ai/' + encodeURIComponent(prompt);
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': ua, 'Accept': 'text/plain' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error('AI service returned ' + res.statusCode);
        e.statusCode = res.statusCode;
        return reject(e);
      }
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 12000) { res.destroy(); } });
      res.on('end', () => resolve(data.trim().slice(0, 4000)));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('AI service timed out')); });
    req.on('error', reject);
  });
}

/* Fallback: POST to the OpenAI-compatible /openai endpoint (text-only).
   This hits a different Pollinations code path than the GET route. */
function pollinationsPostFallbackOnce(prompt, timeoutMs, ua) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'openai',
      messages: [{ role: 'user', content: prompt.slice(0, 6000) }],
      max_tokens: 1000,
    });
    const req = https.request({
      hostname: 'text.pollinations.ai',
      path: '/openai',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': ua,
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error('AI fallback returned ' + res.statusCode);
        e.statusCode = res.statusCode;
        return reject(e);
      }
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 24000) { res.destroy(); } });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (content && content.trim()) return resolve(content.trim().slice(0, 4000));
        } catch (e) { /* fall through */ }
        resolve('');
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('AI service timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function isClientErrorFastFail(err) {
  const code = err && err.statusCode;
  return typeof code === 'number' && code >= 400 && code < 500 && code !== 429;
}

/* ------------------------------------------------------------------ */
/* Google Gemini — primary AI provider (key from env var only).        */
/* Set GEMINI_API_KEY as a Render environment variable. Never commit   */
/* the key to source. Pollinations remains as automatic fallback.      */
/* ------------------------------------------------------------------ */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

/** Call Google Gemini (gemini-flash-latest). Resolves text or throws. */
function geminiText(prompt, systemPrompt, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const key = GEMINI_API_KEY;
    if (!key) {
      const e = new Error('Gemini API key not configured');
      e.statusCode = 401;
      return reject(e);
    }
    const body = JSON.stringify({
      contents: [{ parts: [{ text: (systemPrompt || '') + '\n\n' + prompt }] }],
      generationConfig: { maxOutputTokens: 1000 },
    });
    const path = '/v1beta/models/gemini-flash-latest:generateContent?key=' + encodeURIComponent(key);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'AyazAIStudio/2.0',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error('Gemini returned ' + res.statusCode);
        e.statusCode = res.statusCode;
        return reject(e);
      }
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 24000) { res.destroy(); } });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
          const text = parts && parts[0] && parts[0].text;
          if (text && text.trim()) return resolve(text.trim().slice(0, 4000));
        } catch (e) { /* fall through */ }
        resolve('');
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Call Pollinations text API with retries + POST fallback. Resolves text or throws. */
async function pollinationsText(prompt, timeoutMs = 60000) {
  const backoffs = [1000, 2000, 4000];
  let lastErr = null;

  // Phase 1: GET route, up to 3 attempts with exponential backoff.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await pollinationsGetOnce(prompt, timeoutMs, pickAIUA());
      if (text) return text;
      lastErr = new Error('empty AI response');
    } catch (e) {
      lastErr = e;
      if (isClientErrorFastFail(e)) break; // 4xx (non-429): retrying won't help
    }
    if (attempt < 2) await aiSleep(backoffs[attempt]);
  }

  // Phase 2: POST /openai fallback route, up to 2 attempts.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await pollinationsPostFallbackOnce(prompt, timeoutMs, pickAIUA());
      if (text) return text;
      lastErr = new Error('empty AI response');
    } catch (e) {
      lastErr = e;
      if (isClientErrorFastFail(e)) break;
    }
    if (attempt < 1) await aiSleep(2000);
  }

  throw lastErr || new Error('AI service unavailable');
}

/** Best-effort vision via Pollinations OpenAI-compatible endpoint. Resolves text or null. */
function pollinationsVision(text, dataUrl, systemPrompt, timeoutMs = 90000) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'openai',
      messages: [
        { role: 'system', content: systemPrompt || 'You are Ayaz AI Assistant, a helpful AI assistant in Ayaz AI Studio. Answer clearly and concisely.' },
        { role: 'user', content: [
          { type: 'text', text: text || 'Describe this image.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ]},
      ],
      max_tokens: 800,
    });
    const req = https.request({
      hostname: 'text.pollinations.ai',
      path: '/openai',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': pickAIUA(),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (content) return resolve(content.trim().slice(0, 4000));
        } catch (e) { /* fall through */ }
        resolve(null);
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

const SYSTEM_PROMPT = 'You are Ayaz AI Assistant, a helpful, friendly AI assistant inside Ayaz AI Studio. Answer clearly and concisely in the user\'s language. Keep responses focused and useful.';

const SMART_PROMPT = 'You are Ayaz AI Assistant in Smart mode inside Ayaz AI Studio. Give thorough, detailed, well-organized answers. ' +
'Use short headings or bold key points where helpful, cover important angles and nuances, give concrete examples, and end with a brief summary. ' +
'Be accurate and complete, but stay focused on what the user asked. Answer in the user\'s language.';

const STUDY_PROMPT = 'You are Ayaz Study Tutor, an expert, encouraging tutor inside Ayaz AI Studio\'s Study Mode. ' +
'Give detailed, well-structured educational explanations. Rules:\n' +
'1. Structure every answer with: a short direct answer first, then a clear step-by-step explanation, then a concrete example, then 2-3 key takeaways.\n' +
'2. For math problems: show EVERY step, explain WHY each step works, define any symbols used, and end with a quick check (e.g. verify the answer).\n' +
'3. For science concepts: explain the idea simply first, then add depth (cause/effect, real-world application).\n' +
'4. For history or other topics: give context, key events/people/dates, and why it matters.\n' +
'5. If the user uploads an image (diagram, graph, handwritten problem): analyze what you can see as carefully as possible, walk through it piece by piece, and if image analysis is unavailable say so honestly and still help from the text.\n' +
'6. Use simple formatting: short paragraphs, numbered steps, bold key terms. No excessive jargon.\n' +
'7. End with one follow-up question or practice suggestion to deepen learning.\n' +
'Be "over smart": thorough, accurate, and genuinely helpful — like the best teacher the student ever had.';

/**
 * POST /api/chat  { message, imageId?, study? }
 * (Authorization: Bearer <token>)
 * study=true switches to Study Mode (detailed educational explanations).
 */
app.post('/api/chat', requireAuth, async (req, res) => {
  const email = req.authEmail;
  const message = (req.body && req.body.message || '').toString().trim().slice(0, 2000);
  const imageId = (req.body && req.body.imageId || '').toString().slice(0, 64);
  const modeParam = (req.body && req.body.mode || '').toString().toLowerCase();
  const studyMode = modeParam === 'study' || !!(req.body && req.body.study);
  const smartMode = !studyMode && modeParam === 'smart';
  if (!message && !imageId) return res.status(400).json({ error: 'Please type a message or attach an image.' });

  const gate = checkChatLimit(email);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.message });

  let imageUrl = null;
  let dataUrl = null;
  if (imageId) {
    const meta = uploadStore[imageId];
    if (meta && fs.existsSync(meta.path)) {
      imageUrl = '/uploads/' + imageId + meta.ext;
      try {
        const buf = fs.readFileSync(meta.path);
        dataUrl = 'data:' + meta.mime + ';base64,' + buf.toString('base64');
      } catch (e) { /* ignore */ }
    }
  }

  let reply = '';
  let visionUsed = false;
  const activePrompt = studyMode ? STUDY_PROMPT : (smartMode ? SMART_PROMPT : SYSTEM_PROMPT);
  try {
    if (dataUrl) {
      const v = await pollinationsVision(message, dataUrl, activePrompt);
      if (v) { reply = v; visionUsed = true; }
    }
    if (!reply) {
      const userText = (message || 'Describe the attached image.') +
        (dataUrl ? '\n(Note: the user attached an image, but image analysis is unavailable right now — answer based on the text only and mention this honestly.)' : '');
      // Primary: Google Gemini. Fallback: Pollinations.
      try {
        if (GEMINI_API_KEY) {
          reply = await geminiText(userText, activePrompt);
        }
      } catch (gErr) { /* fall through to Pollinations */ }
      if (!reply) {
        const prompt = activePrompt + '\n\nUser: ' + userText;
        reply = await pollinationsText(prompt);
      }
    }
    if (!reply) throw new Error('empty AI response');
  } catch (e) {
    const cls = classifyAIError(e);
    return res.status(cls.httpStatus).json({ error: cls.userMessage });
  }

  const left = recordChatUsage(email);
  recordChatMessage(email, 'user', (studyMode ? '📚 ' : (smartMode ? '🧠 ' : '')) + (message || '(image attached)'), imageUrl);
  recordChatMessage(email, 'ai', reply, null);
  res.json({ reply, visionUsed, studyMode, smartMode, chatsLeft: left });
});

/**
 * GET /api/chat/history  (Authorization: Bearer <token>)
 */
app.get('/api/chat/history', requireAuth, (req, res) => {
  res.json({ messages: chatStore.users[req.authEmail] || [] });
});

/**
 * DELETE /api/chat/history  (Authorization: Bearer <token>)
 */
app.delete('/api/chat/history', requireAuth, (req, res) => {
  chatStore.users[req.authEmail] = [];
  saveChat();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Image uploads (for chat attach + Imagine "edit this photo")         */
/*                                                                     */
/* POST /api/upload { image: "data:image/...;base64,...", name? }       */
/* Auth required. 5MB max. Files live in the OS temp dir and are       */
/* served at /uploads/<id>. Old files (>24h) are pruned on upload.     */
/* Ephemeral on free hosting — uploads vanish on restart (documented). */
/* ------------------------------------------------------------------ */

const UPLOAD_DIR = path.join(os.tmpdir(), 'aas-uploads');
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const uploadStore = {}; // id -> { path, mime, ext, createdAt }

try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1d' }));

function pruneUploads() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (e) {}
    }
  } catch (e) {}
  for (const id of Object.keys(uploadStore)) {
    if (uploadStore[id].createdAt < cutoff) delete uploadStore[id];
  }
}

/**
 * POST /api/upload  { image: dataURL }
 * (Authorization: Bearer <token>)
 */
app.post('/api/upload', requireAuth, express.json({ limit: '6mb' }), (req, res) => {
  const dataUrl = (req.body && req.body.image || '').toString();
  const m = dataUrl.match(/^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Please upload a PNG, JPEG, WEBP or GIF image.' });
  const mime = m[1];
  const ext = '.' + (m[2] === 'jpeg' ? 'jpg' : m[2]);
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > UPLOAD_MAX_BYTES) {
    return res.status(400).json({ error: 'Image is too large (max 5MB).' });
  }
  pruneUploads();
  const id = crypto.randomBytes(12).toString('hex');
  const filePath = path.join(UPLOAD_DIR, id + ext);
  try {
    fs.writeFileSync(filePath, buf);
  } catch (e) {
    return res.status(500).json({ error: 'Could not save the image. Please try again.' });
  }
  uploadStore[id] = { path: filePath, mime, ext, createdAt: Date.now() };
  res.status(201).json({ id, url: '/uploads/' + id + ext });
});

// Delete-account cleanup: also wipe chat history for the account.
const _origDeleteAccount = null; // (handled inline below via chatStore)

/* ------------------------------------------------------------------ */
/* Generation queue — agent-processed requests (max 100 pending each)  */
/*                                                                     */
/* Users submit prompts; the agent processes them manually for better  */
/* quality than the free auto path. "Normal quality" for now:          */
/*   - video: 720p                                                     */
/*   - image: 1024px                                                   */
/*                                                                     */
/* Storage: video_queue.json / image_queue.json (file-based, same      */
/* ephemeral-on-free-hosting caveat as users/usage).                   */
/*                                                                     */
/* Request shape:                                                      */
/*   { id, userId, kind, prompt, status, createdAt, resultUrl,          */
/*     ...kindParams }                                                 */
/* status: 'pending' | 'processing' | 'done' | 'failed'                */
/*                                                                     */
/* MANUAL PROCESSING (for the agent):                                  */
/*   1. Read video_queue.json / image_queue.json, take oldest          */
/*      'pending' item, set status to 'processing'.                    */
/*   2. Generate the media (720p video / 1024px image).                */
/*   3. Upload the file somewhere public (or serve from /uploads) and  */
/*      set status to 'done' + resultUrl to the download URL.          */
/*      On failure set status to 'failed'.                             */
/*   4. Save the JSON file. The user sees it in Library → Requests.    */
/* ------------------------------------------------------------------ */
const VIDEO_QUEUE_FILE = path.join(__dirname, 'video_queue.json');
const IMAGE_QUEUE_FILE = path.join(__dirname, 'image_queue.json');
const QUEUE_MAX_PENDING = 100;

function loadQueueFile(file) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { console.log(path.basename(file), 'unreadable, starting fresh'); }
  return [];
}
function saveQueueFile(file, arr) {
  fs.writeFile(file, JSON.stringify(arr), (e) => {
    if (e) console.log('queue save failed:', e.message);
  });
}
let videoQueue = loadQueueFile(VIDEO_QUEUE_FILE);
let imageQueue = loadQueueFile(IMAGE_QUEUE_FILE);

function pendingQueueItems(arr) {
  return arr
    .filter((q) => q.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
function queuePosition(arr, id) {
  const idx = pendingQueueItems(arr).findIndex((q) => q.id === id);
  return idx >= 0 ? idx + 1 : null;
}
function enqueueRequest(arr, file, item) {
  if (pendingQueueItems(arr).length >= QUEUE_MAX_PENDING) return null;
  const entry = Object.assign(
    {
      id: crypto.randomBytes(8).toString('hex'),
      status: 'pending',
      createdAt: new Date().toISOString(),
      resultUrl: null,
    },
    item
  );
  arr.push(entry);
  saveQueueFile(file, arr);
  return entry;
}

/**
 * POST /api/queue/video { prompt, duration?, motion? } — auth required
 * Adds a video request to the agent queue (max 100 pending).
 */
app.post('/api/queue/video', requireAuth, (req, res) => {
  const prompt = ((req.body && req.body.prompt) || '').toString().trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const duration = Math.min(Math.max(parseInt(req.body.duration) || 5, 3), 8);
  const motion = ['zoomin', 'zoomout', 'panleft', 'panright'].includes(req.body.motion)
    ? req.body.motion : 'zoomin';
  const entry = enqueueRequest(videoQueue, VIDEO_QUEUE_FILE, {
    userId: req.authEmail, kind: 'video', prompt, duration, motion,
  });
  if (!entry) return res.status(429).json({ error: 'Video queue is full (100). Please try again later.' });
  res.status(201).json({
    ok: true, id: entry.id,
    position: queuePosition(videoQueue, entry.id),
    pending: pendingQueueItems(videoQueue).length,
  });
});

/**
 * POST /api/queue/image { prompt, width?, height? } — auth required
 * Adds an image request to the agent queue (max 100 pending).
 */
app.post('/api/queue/image', requireAuth, (req, res) => {
  const prompt = ((req.body && req.body.prompt) || '').toString().trim().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const width = Math.min(Math.max(parseInt(req.body.width) || 1024, 256), 1024);
  const height = Math.min(Math.max(parseInt(req.body.height) || 1024, 256), 1024);
  const entry = enqueueRequest(imageQueue, IMAGE_QUEUE_FILE, {
    userId: req.authEmail, kind: 'image', prompt, width, height,
  });
  if (!entry) return res.status(429).json({ error: 'Image queue is full (100). Please try again later.' });
  res.status(201).json({
    ok: true, id: entry.id,
    position: queuePosition(imageQueue, entry.id),
    pending: pendingQueueItems(imageQueue).length,
  });
});

/**
 * GET /api/queue/status — auth required
 * Returns pending counts for both queues.
 */
app.get('/api/queue/status', requireAuth, (req, res) => {
  res.json({
    videoQueue: pendingQueueItems(videoQueue).length,
    imageQueue: pendingQueueItems(imageQueue).length,
    videoMax: QUEUE_MAX_PENDING,
    imageMax: QUEUE_MAX_PENDING,
  });
});

/**
 * GET /api/queue/my — auth required
 * Returns the requesting user's queue items (both kinds), newest first,
 * each pending item carrying its live queue position.
 */
app.get('/api/queue/my', requireAuth, (req, res) => {
  const mine = videoQueue.concat(imageQueue).filter((q) => q.userId === req.authEmail);
  const out = mine
    .map((q) => {
      const arr = q.kind === 'video' ? videoQueue : imageQueue;
      return Object.assign({}, q, {
        position: q.status === 'pending' ? queuePosition(arr, q.id) : null,
      });
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ requests: out });
});

/**
 * DELETE /api/queue/:id — auth required
 * Cancels the user's own pending request.
 */
app.delete('/api/queue/:id', requireAuth, (req, res) => {
  const id = (req.params.id || '').toString();
  for (const [arr, file] of [[videoQueue, VIDEO_QUEUE_FILE], [imageQueue, IMAGE_QUEUE_FILE]]) {
    const idx = arr.findIndex((q) => q.id === id && q.userId === req.authEmail);
    if (idx >= 0) {
      if (arr[idx].status !== 'pending') {
        return res.status(409).json({ error: 'Only pending requests can be cancelled.' });
      }
      arr.splice(idx, 1);
      saveQueueFile(file, arr);
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'Request not found.' });
});

app.listen(PORT, () => console.log(`Ayaz AI Studio running on http://localhost:${PORT}`));
