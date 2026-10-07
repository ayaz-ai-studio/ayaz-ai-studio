# 🎨 Ayaz AI Studio — Phase 4 (Rewarded Ads + Credits)

A REAL, PUBLIC web app for free AI image + video generation. **Not a Muse artifact** — plain Node.js + Express, deployable to free hosting in minutes.

## What's new in Phase 4 — Rewarded Ads 📺

- ✅ **"📺 Ad Dekho, +2 Credits Pao" button** — prominent, pulsing, in the user panel
- ✅ **30-second ad countdown modal** — simulated ad view (progress bar + timer); real Adsterra unit drops in later via the `ADSTERRA_PLACEHOLDER` comment in `public/index.html`
- ✅ **Credit system**: each completed ad view = **+2 images, +1 video**, max **5 watches/day** per user
- ✅ **New endpoint**: `POST /api/watch-ad-complete` `{ username }` → awards credits, returns updated credit state
- ✅ **Live credit balance**: `🖼️ Images x/y • 🎬 Videos x/y • 📺 Ads x/5`, updates after every generation and ad
- ✅ **Generate buttons auto-disable** when credits are exhausted, with a "📺 Ad dekho" prompt
- ✅ **Toast notifications**: "🎉 Mubarak! +2 images, +1 video credits mil gaye!"
- ✅ **Ad provider flag**: `AD_PROVIDER` env var (`simulated` | `adsterra`); exposed in `/api/health`
- ✅ **Anti-fraud notes**: in adsterra mode, `/api/watch-ad-complete` must be called only after server-side postback verification

## What's in Phase 3

- ✅ **Deployment-ready**: `process.env.PORT`, `npm start` script, Node 18+ engines, `render.yaml` blueprint
- ✅ **Simple user system**: username-based (no password yet) — name saved in browser
- ✅ **Daily limits**: 6 images + 3 videos per user per day, enforced server-side
- ✅ **Credits display**: UI shows remaining images/videos, updates live after each generation
- ✅ **ffmpeg on Render**: `render.yaml` installs ffmpeg automatically in the build step
- ✅ **`.gitignore`**: node_modules, .env, usage.json never committed

## API reference

**Images** — `GET /api/generate-image?prompt=...&width=512&height=512&seed=123&username=ali`
- Pollinations.ai (free, keyless) primary; Hugging Face SDXL fallback if `HF_TOKEN` set

**Videos** — `GET /api/generate-video?prompt=...&duration=5&motion=zoomin&seed=123&username=ali`
- AI still → ffmpeg Ken Burns animation → real MP4 (720×720, 25fps)
- `duration`: 3–8 sec, `motion`: zoomin | zoomout | panleft | panright
- Header `X-Video-Source`: `animated-still` (free path) or `huggingface` (rare)

**Credits** — `GET /api/me?username=ali` →
```json
{ "user":"ali", "limits":{"images":6,"videos":3}, "totals":{"images":8,"videos":4},
  "bonus":{"images":2,"videos":1}, "used":{"images":0,"videos":0},
  "remaining":{"images":8,"videos":4},
  "ads":{"watched":1,"max":5,"rewardImages":2,"rewardVideos":1}, "adProvider":"simulated" }
```

**Watch ad** — `POST /api/watch-ad-complete` `{ "username":"ali" }` →
- Awards +2 images / +1 video (per-day cap: 5 watches)
- 429 when: no username (401), or daily ad cap reached
- Response includes the "Mubarak!" message + updated `credits` snapshot

**Health** — `GET /api/health` → `{ ok, hfFallback, video, adProvider, adsPerDay, adReward }`

## How the ad system works (and how to go real)

1. User taps **📺 Ad Dekho** → modal opens with a 30s countdown (simulated ad).
2. At 0s the frontend calls `POST /api/watch-ad-complete`.
3. Server checks the daily cap (5/day), awards +2 images / +1 video, updates `usage.json`, returns fresh credits.
4. UI shows the toast, re-enables generate buttons, updates the Ads counter.

**Going real with Adsterra:**
1. Sign up at Adsterra (approval ~5–10 min) and create a **Rewarded Ad** unit for your live URL.
2. Paste Adsterra's script into `public/index.html` at the `ADSTERRA_PLACEHOLDER` comment.
3. Set `AD_PROVIDER=adsterra` in Render → Environment.
4. Wire Adsterra's rewarded-callback to call `/api/watch-ad-complete` — and add their server-side postback verification before awarding (prevents fake views).

## What works

**Images** — `/api/generate-image?prompt=...&width=512&height=512&seed=123&username=ali`
- Pollinations.ai (free, keyless) primary; Hugging Face SDXL fallback if `HF_TOKEN` set

**Videos** — `/api/generate-video?prompt=...&duration=5&motion=zoomin&seed=123&username=ali`
- AI still → ffmpeg Ken Burns animation → real MP4 (720×720, 25fps)
- `duration`: 3–8 sec, `motion`: zoomin | zoomout | panleft | panright
- Header `X-Video-Source`: `animated-still` (free path) or `huggingface` (rare)

**Users & limits** — `/api/me?username=ali` → `{ user, limits, used, remaining }`
- Username from the name box (saved in browser localStorage)
- 6 images + 3 videos per day; resets at midnight UTC
- Usage stored in `usage.json` next to server.js

## Honest limits (read before launch!)

1. **Video is animated stills, not true AI video.** 3–8s zoom/pan over an AI picture. Veo/Kling-quality video is paid-only — needs user-paid credits (future phase).
2. **No real authentication.** Anyone can type any username. Fine for a free public demo; real launch needs Better Auth or Supabase Auth.
3. **Usage resets when the server sleeps.** Render's free tier sleeps after 15 min idle and has an ephemeral filesystem, so `usage.json` can be wiped. Real launch needs a database (Supabase Postgres, free tier).
4. **No rate limiting per IP.** A determined user could hammer the endpoints. Add express-rate-limit before real launch.
5. **Pollinations.ai is a free third-party service** — rate-limited, may throttle under heavy use, small watermark possible.
6. **No content moderation** on prompts yet.

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
   git commit -m "Ayaz AI Studio Phase 3"
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
- Type a name → Generate → it works from any phone/browser 🎉

### Notes
- **Free tier sleeps** after 15 min of no traffic; first request wakes it (~1 min). Upgrade to $7/mo Starter to keep it always on.
- **usage.json is ephemeral** on free tier — daily limits may reset if the service restarts. Acceptable for launch; add Supabase later.
- To update the site: `git push` to GitHub → Render auto-redeploys.

## What's still missing for a real production launch

| Gap | Fix (future) |
|---|---|
| Real login (email/Google) | Better Auth or Supabase Auth (both free tier) |
| Persistent usage limits | Supabase Postgres table (free 500MB) |
| True AI video (Veo 3.1) | Paid API + credit system — users pay per generation (Rs. 150–200/video) |
| Rate limiting / abuse protection | `express-rate-limit` + CAPTCHA on generate |
| Prompt content moderation | Blocklist + HF safety checker |
| Payments (Pakistan) | Manual JazzCash/Easypaisa first, then Safepay |
| Rewarded ads for extra credits | ✅ Simulated 30s view + credits done (Phase 4); swap in real Adsterra unit later |
| Custom domain | ~$10–12/year (Namecheap/Cloudflare) + free Cloudflare Pages frontend |

## Project structure

```
ayaz-ai-studio-real/
├── server.js          # Express backend: image/video APIs, user limits, rewarded ads
├── package.json       # npm start, Node >= 18
├── render.yaml        # Render Blueprint (auto ffmpeg install)
├── .gitignore
├── usage.json         # (created at runtime) daily usage + ad watches per username — gitignored
├── public/
│   └── index.html     # Mobile-friendly UI: name box, credits, image/video tabs, ad modal + toast
├── sample-output.jpg  # Proof: real generated image
└── sample-output-video.mp4  # Proof: real generated video (3s)
```
