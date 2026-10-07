# 🎨 Ayaz AI Studio — Phase 5 (Real Accounts + English UI)

A REAL, PUBLIC web app for free AI image + video generation. **Not a Muse artifact** — plain Node.js + Express, deployable to free hosting in minutes.

## What's new in Phase 5 — Real Accounts 🔐 + English UI 🇬🇧

- ✅ **Email + password registration/login** — `POST /api/register`, `POST /api/login`, `POST /api/logout`
- ✅ **Hashed passwords** — PBKDF2 (SHA-512, 120k iterations, unique salt per user); plain passwords never stored
- ✅ **Token-based sessions** — random 256-bit bearer tokens, 30-day expiry, max 5 sessions per account, stored in `users.json`
- ✅ **Protected endpoints** — `/api/generate-image`, `/api/generate-video`, `/api/watch-ad-complete`, `/api/me` all require `Authorization: Bearer <token>`
- ✅ **Usage tracked per account (email)** — stable identity; no more spoofable usernames
- ✅ **Login/register modal in the UI** — shows signed-in email, Sign Out button; generation UI locked until signed in
- ✅ **Whole UI now in professional English** — all previous Roman-Urdu strings translated
- ✅ **`users.json` gitignored** — accounts never committed

## Phase 4 — Rewarded Ads 📺

- ✅ **"📺 Watch Ad, Get +2 Credits" button** — prominent, pulsing, in the user panel
- ✅ **30-second ad countdown modal** — simulated ad view (progress bar + timer); real Adsterra unit drops in later via the `ADSTERRA_PLACEHOLDER` comment in `public/index.html`
- ✅ **Credit system**: each completed ad view = **+2 images, +1 video**, max **5 watches/day** per account
- ✅ **New endpoint**: `POST /api/watch-ad-complete` (auth required) → awards credits, returns updated credit state
- ✅ **Live credit balance**: `🖼️ Images x/y • 🎬 Videos x/y • 📺 Ads x/5`, updates after every generation and ad
- ✅ **Generate buttons auto-disable** when credits are exhausted, with a "watch an ad" prompt
- ✅ **Toast notifications**: "🎉 Congratulations! +2 images, +1 video credits earned!"
- ✅ **Ad provider flag**: `AD_PROVIDER` env var (`simulated` | `adsterra`); exposed in `/api/health`
- ✅ **Anti-fraud notes**: in adsterra mode, `/api/watch-ad-complete` must be called only after server-side postback verification

## Phase 3

- ✅ **Deployment-ready**: `process.env.PORT`, `npm start` script, Node 18+ engines, `render.yaml` blueprint
- ✅ **Daily limits**: 6 images + 3 videos per account per day, enforced server-side
- ✅ **Credits display**: UI shows remaining images/videos, updates live after each generation
- ✅ **ffmpeg on Render**: `render.yaml` installs ffmpeg automatically in the build step

## API reference

All protected endpoints need `Authorization: Bearer <token>` (token from register/login).

**Auth**
- `GET /api/captcha` → `{ "id":"...", "question":"7 + 5" }` — math CAPTCHA (one-time use, expires in 5 min)
- `POST /api/register` `{ "email":"a@b.com", "password":"secret123", "captchaId":"...", "captchaAnswer":"12" }` → `201 { token, email, credits }`
  - 400: invalid email / password < 6 chars / wrong CAPTCHA (`code: "captcha_failed"`) · 409: email already registered
- `POST /api/login` `{ "email":"a@b.com", "password":"secret123", "captchaId":"...", "captchaAnswer":"12" }` → `{ token, email, credits }`
  - 400: wrong CAPTCHA · 401: invalid email or password
- `POST /api/logout` (auth) → `{ ok: true }` — invalidates the current session token
- `POST /api/change-password` (auth) `{ "currentPassword":"...", "newPassword":"..." }` → `{ ok: true }` — new password min 6 chars, must differ; other sessions are revoked
- `DELETE /api/account` (auth) `{ "password":"..." }` → `{ ok: true }` — permanently deletes the account + its usage data (password confirmation required)
- `GET /api/me` (auth) → full credit snapshot:
```json
{ "email":"a@b.com", "limits":{"images":6,"videos":3}, "totals":{"images":8,"videos":4},
  "bonus":{"images":2,"videos":1}, "used":{"images":0,"videos":0},
  "remaining":{"images":8,"videos":4},
  "ads":{"watched":1,"max":5,"rewardImages":2,"rewardVideos":1}, "adProvider":"simulated" }
```

**Images** (auth) — `GET /api/generate-image?prompt=...&width=512&height=512&seed=123`
- Pollinations.ai (free, keyless) primary; Hugging Face SDXL fallback if `HF_TOKEN` set
- 401 without token · 429 when the daily image limit is reached

**Videos** (auth) — `GET /api/generate-video?prompt=...&duration=5&motion=zoomin&seed=123`
- AI still → ffmpeg Ken Burns animation → real MP4 (720×720, 25fps)
- `duration`: 3–8 sec, `motion`: zoomin | zoomout | panleft | panright
- Header `X-Video-Source`: `animated-still` (free path) or `huggingface` (rare)
- 401 without token · 429 when the daily video limit is reached

**Watch ad** (auth) — `POST /api/watch-ad-complete` → awards +2 images / +1 video
- 429 when the daily ad cap (5) is reached
- Response includes the "Congratulations!" message + updated `credits` snapshot

**Health** — `GET /api/health` → `{ ok, hfFallback, video, auth, adProvider, adsPerDay, adReward }`

## How the ad system works (and how to go real)

1. User taps **📺 Watch Ad** → modal opens with a 30s countdown (simulated ad).
2. At 0s the frontend calls `POST /api/watch-ad-complete` with the auth token.
3. Server checks the daily cap (5/day), awards +2 images / +1 video, updates `usage.json`, returns fresh credits.
4. UI shows the toast, re-enables generate buttons, updates the Ads counter.

**Going real with Adsterra:**
1. Sign up at Adsterra (approval ~5–10 min) and create a **Rewarded Ad** unit for your live URL.
2. Paste Adsterra's script into `public/index.html` at the `ADSTERRA_PLACEHOLDER` comment.
3. Set `AD_PROVIDER=adsterra` in Render → Environment.
4. Wire Adsterra's rewarded-callback to call `/api/watch-ad-complete` — and add their server-side postback verification before awarding (prevents fake views).

## Honest limits (read before launch!)

1. **Video is animated stills, not true AI video.** 3–8s zoom/pan over an AI picture. Veo/Kling-quality video is paid-only — needs user-paid credits (future phase).
2. **File-based accounts.** `users.json`/`usage.json` reset when Render's free tier sleeps/restarts (ephemeral filesystem). No email verification, no login rate limiting — production needs Supabase Postgres + Supabase Auth (or Better Auth).
3. **Pollinations.ai is a free third-party service** — rate-limited, may throttle under heavy use, small watermark possible.
4. **No rate limiting per IP.** A determined user could hammer the endpoints. Add express-rate-limit before real launch.
5. **No content moderation** on prompts yet.

## Run locally

```bash
cd ayaz-ai-studio-real
npm install
node server.js        # or: npm start
# open http://localhost:3000
```

Optional (enables HF fallback):
```bash
# Free token: https://huggingface.co/settings/tokens (read-only is enough)
HF_TOKEN=hf_xxx npm start
```

## Deploy to Render (free) — step by step

You need: a GitHub account + a Render account (both free). ~10 minutes.

### Step 1 — Push to GitHub
1. Go to https://github.com/new — create a new repository named `ayaz-ai-studio` (Public).
2. On your computer / in this workspace:
   ```bash
   cd ayaz-ai-studio-real
   git init
   git add .
   git commit -m "Ayaz AI Studio"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/ayaz-ai-studio.git
   git push -u origin main
   ```
   (When git asks for a password, use a GitHub Personal Access Token, not your password:
   GitHub → Settings → Developer settings → Personal access tokens → Generate.)

### Step 2 — Create the Render service (2 ways)

**Way A — Blueprint (fastest, uses render.yaml):**
1. Go to https://dashboard.render.com → **New +** → **Blueprint**
2. Connect your GitHub account, select the `ayaz-ai-studio` repo
3. Render reads `render.yaml` automatically → click **Apply**
4. Done — Render builds (installs ffmpeg, takes a few minutes on first deploy)

**Way B — Manual Web Service:**
1. https://dashboard.render.com → **New +** → **Web Service**
2. Connect GitHub → select `ayaz-ai-studio` repo
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install && (which ffmpeg || (apt-get update && apt-get install -y ffmpeg))`
   - **Start Command:** `node server.js`
   - **Plan:** Free
4. (Optional) Environment → Add `HF_TOKEN` = your free Hugging Face token
5. Click **Create Web Service**

### Step 3 — Open your site
- Render gives you a URL like `https://ayaz-ai-studio.onrender.com`
- First load after idle takes ~30–60s (free tier wakes from sleep) — normal
- Create an account → Sign in → Generate → works from any phone/browser 🎉

### Notes
- **Free tier sleeps** after 15 min of no traffic; first request wakes it (~1 min). Upgrade to $7/mo Starter to keep it always on.
- **users.json/usage.json are ephemeral** on free tier — accounts and limits may reset if the service restarts. Acceptable for launch; add Supabase later.
- To update the site: `git push` to GitHub → Render auto-redeploys.

## What's still missing for a real production launch

| Gap | Fix (future) |
|---|---|
| Persistent accounts + limits | Supabase Postgres + Supabase Auth (free 500MB) |
| Email verification, OAuth login | Supabase Auth / Better Auth |
| Login rate limiting / brute-force protection | `express-rate-limit` on /api/login + /api/register |
| True AI video (Veo 3.1) | Paid API + credit system — users pay per generation (Rs. 150–200/video) |
| Rate limiting / abuse protection | `express-rate-limit` + CAPTCHA on generate |
| Prompt content moderation | Blocklist + HF safety checker |
| Payments (Pakistan) | Manual JazzCash/Easypaisa first, then Safepay |
| Rewarded ads for extra credits | ✅ Simulated 30s view + credits done; swap in real Adsterra unit later |
| Custom domain | ~$10–12/year (Namecheap/Cloudflare) + free Cloudflare Pages frontend |

## Project structure

```
ayaz-ai-studio-real/
├── server.js          # Express backend: auth, image/video APIs, limits, rewarded ads
├── package.json       # npm start, Node >= 18
├── render.yaml        # Render Blueprint (auto ffmpeg install)
├── .gitignore         # node_modules, .env, usage.json, users.json never committed
├── users.json         # (created at runtime) hashed accounts + sessions — gitignored
├── usage.json         # (created at runtime) daily usage + ad watches per email — gitignored
├── public/
│   └── index.html     # Mobile-friendly English UI: auth modal, credits, image/video tabs, ad modal + toast
├── sample-output.jpg  # Proof: real generated image
└── sample-output-video.mp4  # Proof: real generated video (3s)
```
