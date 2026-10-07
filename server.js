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
/* Phase 3 — simple user system + daily limits                          */
/*                                                                     */
/* Username-based sessions (no password for now). Usage is tracked in   */
/* a local JSON file.                                                   */
/* HONEST LIMIT: free hosting (Render free tier) has an EPHEMERAL       */
/* filesystem — usage.json resets whenever the service restarts or      */
/* sleeps. Real production needs a database (Supabase Postgres).        */
/* Also: usernames are not authenticated — anyone can type any name.    */
/* Real production needs proper auth (Better Auth / Supabase Auth).     */
/* ------------------------------------------------------------------ */

const DAILY_IMAGE_LIMIT = 6;
const DAILY_VIDEO_LIMIT = 3;
const USAGE_FILE = path.join(__dirname, 'usage.json');

/* ------------------------------------------------------------------ */
/* Phase 4 — rewarded ads (simulated for now)                           */
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
function cleanName(n) { return (n || '').toString().trim().slice(0, 30); }

function getUsage(name) {
  const today = todayStr();
  let rec = usageStore.users[name];
  if (!rec || rec.date !== today) {
    rec = { date: today, images: 0, videos: 0, ads: 0, bonusImages: 0, bonusVideos: 0 };
    usageStore.users[name] = rec;
  }
  return rec;
}

/** Check the limit WITHOUT recording. Returns {ok} or {ok:false,status,message}. */
function checkLimit(name, type) {
  const clean = cleanName(name);
  if (!clean) return { ok: false, status: 401, message: 'Pehle apna naam set karein (upar name box mein).' };
  const rec = getUsage(clean);
  const baseLimit = type === 'image' ? DAILY_IMAGE_LIMIT : DAILY_VIDEO_LIMIT;
  const bonus = type === 'image' ? (rec.bonusImages || 0) : (rec.bonusVideos || 0);
  const limit = baseLimit + bonus;
  const used = type === 'image' ? rec.images : rec.videos;
  if (used >= limit) {
    return { ok: false, status: 429, message: `Aaj ki ${type === 'image' ? 'image' : 'video'} limit khatam! (${used}/${limit}). 📺 Ad dekh kar extra credits pao, ya kal phir try karein.` };
  }
  return { ok: true, user: clean };
}

/** Record one generation after it succeeded. */
function recordUsage(name, type) {
  const rec = getUsage(cleanName(name));
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

/** Public credits snapshot for a username (no recording). */
function creditsFor(name) {
  const clean = cleanName(name);
  const rec = clean ? getUsage(clean) : { images: 0, videos: 0, ads: 0, bonusImages: 0, bonusVideos: 0 };
  const bonusImages = rec.bonusImages || 0;
  const bonusVideos = rec.bonusVideos || 0;
  const totalImages = DAILY_IMAGE_LIMIT + bonusImages;
  const totalVideos = DAILY_VIDEO_LIMIT + bonusVideos;
  return {
    user: clean || null,
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
 * Body: { username }
 * Simulated mode: frontend calls this after its 30s countdown.
 * Adsterra mode: call ONLY after server-side postback verifies the view.
 */
app.post('/api/watch-ad-complete', (req, res) => {
  const name = cleanName(req.body && req.body.username);
  if (!name) return res.status(401).json({ error: 'Pehle apna naam set karein (upar name box mein).' });
  const rec = getUsage(name);
  rec.ads = rec.ads || 0;
  if (rec.ads >= MAX_ADS_PER_DAY) {
    return res.status(429).json({ error: `Aaj ke ${MAX_ADS_PER_DAY} ads dekh liye! Kal phir try karein.` });
  }
  rec.ads++;
  rec.bonusImages = (rec.bonusImages || 0) + AD_REWARD_IMAGES;
  rec.bonusVideos = (rec.bonusVideos || 0) + AD_REWARD_VIDEOS;
  saveUsage();
  res.json({
    message: `Mubarak! +${AD_REWARD_IMAGES} images, +${AD_REWARD_VIDEOS} video credits mil gaye!`,
    adsWatched: rec.ads,
    adsMax: MAX_ADS_PER_DAY,
    credits: creditsFor(name),
  });
});

/** GET /api/me?username=X -> { user, limits, used, remaining } */
app.get('/api/me', (req, res) => {
  res.json(creditsFor(req.query.username));
});

/**
 * GET /api/generate-image?prompt=...&width=...&height=...
 * Primary: Pollinations.ai (free, no key required)
 * Fallback: Hugging Face Inference router (needs HF_TOKEN)
 */
app.get('/api/generate-image', (req, res) => {
  const prompt = (req.query.prompt || '').toString().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // Phase 3: daily limit check (recorded only after the provider returns 200)
  const gate = checkLimit(req.query.username, 'image');
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
      if (HF_TOKEN) return generateViaHF(prompt, res, req.query.username);
      return res.status(502).json({ error: 'image provider returned ' + imgRes.statusCode });
    }
    const left = recordUsage(req.query.username, 'image');
    res.setHeader('X-Images-Left', left.images);
    res.setHeader('X-Videos-Left', left.videos);
    res.setHeader('X-Images-Total', left.totalImages);
    res.setHeader('X-Videos-Total', left.totalVideos);
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.pipe(res);
  }).on('error', (e) => {
    if (HF_TOKEN) return generateViaHF(prompt, res, req.query.username);
    res.status(502).json({ error: 'image provider unreachable: ' + e.message });
  });
});

/** Fallback: Hugging Face Inference router (SDXL). Needs HF_TOKEN env var. */
function generateViaHF(prompt, res, username) {
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
    const left = recordUsage(username, 'image');
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
  adProvider: AD_PROVIDER,
  adsPerDay: MAX_ADS_PER_DAY,
  adReward: { images: AD_REWARD_IMAGES, videos: AD_REWARD_VIDEOS },
}));

/* ------------------------------------------------------------------ */
/* Phase 2 — FREE video generation                                      */
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
 * duration: 3–8 seconds (default 5). motion: zoomin|zoomout|panleft|panright.
 * Streams back an MP4 (720x720, 25fps, h264).
 */
app.get('/api/generate-video', async (req, res) => {
  const prompt = (req.query.prompt || '').toString().slice(0, 500);
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  // Phase 3: daily limit check (recorded only after a video is produced)
  const gate = checkLimit(req.query.username, 'video');
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
      const left = recordUsage(req.query.username, 'video');
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
    const left = recordUsage(req.query.username, 'video');
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
