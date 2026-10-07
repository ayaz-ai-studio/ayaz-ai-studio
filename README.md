# 🎨 Ayaz AI Studio — Phase 14 (Build Tab + Imagine Templates + Settings)

A REAL, PUBLIC web app for free AI chat, tutoring, image + video generation. **Not a Muse artifact** — plain Node.js + Express, deployable to free hosting in minutes.

## What's new in Phase 14 — 🔨 Build Tab, Featured Templates, Imagine Settings

**🔨 Build tab (third main tab: Ask | Imagine | Build):**
- ✅ Center hero with 🔨 icon + "Build apps and sites" text.
- ✅ "Create from Template" horizontal scrollable cards: ➕ Vector field, 📊 Poll app, ✨ AI Landing page, 🛒 Mini store — tap to load the prompt.
- ✅ Bottom "Type to Build..." bar with +, mic (voice), and ➤ send; Enter-to-send.
- ✅ AI generates a **complete single-file HTML app** via `POST /api/chat` (mode: smart); the code block is extracted and shown in a bottom-sheet with a **live iframe preview**, **Copy Code** button, and **Download .html** button.

**🌟 Featured Templates (Imagine tab, Grok style):**
- ✅ 2×2 grid with gradient cards: 📷 Photo Edit (opens photo upload), 🎨 Reimagine (scrolls to trending styles), 📐 Smart Resize (cycles size options), 🖼️ BG Removal & Change (prefills a background-change prompt).

**⚙️ Imagine Settings (bottom sheet, Grok style):**
- ✅ Gear button at the top of the Imagine tab opens a dark bottom sheet with:
  - **Video:** aspect ratio (1:1/2:3/3:2/16:9), duration slider (3–10s), resolution (480p/720p), video-with-audio toggle.
  - **Image:** aspect ratio (1:1/2:3/3:2/16:9), Image Gen Mode segmented control (Speed/Quality — Quality adds a detail suffix to prompts).
  - **General:** Add Watermark toggle (brand overlay on image results), Autoplay videos toggle.
- ✅ Settings persist in `localStorage` (`aas_imagine_settings`) and are applied automatically: image aspect → size select, duration → duration select, autoplay → result video, watermark → overlay on results. Extra video params (`res`, `audio`) are passed to `/api/generate-video`.

**🔄 Refresh button (header):**
- ✅ Top-right 🔄 button with spin animation — refreshes credits, chat history, trending styles, offer cards, and featured templates in one tap.

## What's new in Phase 13 — 🤖 Ayaz Bot Widget (Grok Bot style)

- ✅ **Floating bot button** (bottom-right, pulsing blue/purple gradient) — one tap opens the quick bot chat from anywhere in the app.
- ✅ **Mini chat panel** — compact Grok-Bot-style widget: header with 🤖 avatar, "Ayaz Bot" name, green "Online" indicator, ⤢ expand-to-full-chat button, ✕ close; friendly branded greeting on first open; typing indicator; Enter-to-send; Escape-to-close.
- ✅ **Drawer integration** — the existing "🤖 Ayaz Bot" drawer item (with "New" badge) now opens the quick widget instead of jumping tabs.
- ✅ **Same backend** — uses the existing `POST /api/chat` (`mode: 'fast'`), so bot chats count toward the daily chat limit and appear in chat history like normal Ask chats. Auth-gated like everything else.

## What's new in Phase 12 — Email Verification ✉️

- ✅ **6-digit verification codes** — registration creates an UNVERIFIED account and issues a crypto-random 6-digit code (15-minute expiry) stored in `users.json` (`emailVerified`, `verificationCode`, `verificationExpiry`).
- ✅ **New endpoints**: `POST /api/verify-email { email, code }` (verifies → returns session token + credits) and `POST /api/resend-verification { email }` (fresh code, rate-limited to 5/hour per email).
- ✅ **Login blocked until verified** — `POST /api/login` returns `403 email_not_verified` for unverified accounts; the app routes straight to the verify screen.
- ✅ **Frontend verify modal** — big spaced 6-digit input, Verify & Resend buttons, Escape-to-close.
- ✅ **Anti-abuse**: referral bonuses are now awarded at VERIFICATION time (not registration), so fake emails can't farm credits.
- ⚠️ **Demo mode (no SMTP yet)**: the code is returned in the API response and shown in the UI ("🔧 Demo mode — no email server configured yet"). **Production TODO**: wire `newVerifyCode()` delivery through Gmail SMTP or SendGrid — the code-generation/storage/verification logic stays exactly the same, only the delivery step changes.

## What's new in Phase 11 — Grok Main Interface Match 📱

- ✅ **Professional two-row bottom prompt bar** (like Grok's "Ask anything") — Row 1: full-width input + send button. Row 2: **+** attach button, **⚡ Fast ▾** model selector dropdown (Fast / Smart / Study), mic button, and a white **Speak** pill that reads the last AI reply aloud (Web Speech API, tap again to stop).
- ✅ **Model selector** — `POST /api/chat` now accepts `mode: 'fast' | 'smart' | 'study'` (backward compatible with the old `study` boolean). Smart mode uses a new `SMART_PROMPT` for thorough, well-organized answers; chat history badges show 📚 STUDY / 🧠 SMART per reply.
- ✅ **Scrollable offer/promo cards** above the prompt bar (visible when chat is empty): 🎁 Refer & Earn, 📺 Watch Ads, 🎨 Trending Styles, 📚 Study Mode, ⭐ Go Pro — each tappable and wired to its feature.
- ✅ **Enhanced drawer** (Grok style):
  - Profile header: avatar circle (email initial), display name, email, » account button
  - ⚡ Automations (daily reminder toggle + time, stored on-device; scheduled auto-generation noted as coming soon)
  - 📚 Library (My Creations), 📁 Projects (save/reuse prompts, on-device), 🤖 Ayaz Bot (New badge, quick assistant greeting)
  - Blue promo banner: "🎉 Invite friends, earn credits" with Claim button → Refer & Earn
  - Chats section: recent chat history (tap to refill the input), More section with all existing items
  - Bottom: search bar (filters menu + history), settings gear, new-chat button
- ✅ **Center logo empty state** — the chat empty screen now shows the official logo large in the center, like Grok's logo.
- ✅ All existing features keep working (auth, CAPTCHA, ads, credits, feedback, creations, referrals, voice input, Imagine tab, themes).

## What's new in Phase 10 — Grok-style Login Screen 🔑 + Official Logo 🅰️

- ✅ **Official logo** — custom AI-generated "A" lettermark with neural-network styling (`public/logo.webp` full lockup, `public/logo-icon.webp` square icon for small placements). Shown in the top bar (32px), hamburger drawer header, footer, and the login screen (100px).
- ✅ **Grok-style full-screen login** — when signed out, the app opens on a pure-black launch screen exactly like Grok's: big logo, large "Ayaz AI Studio" title, typewriter tagline ("Create anything_" with blinking cursor), and three rounded dark-gray buttons:
  - **G Continue with Google** → "coming soon" toast (real Google OAuth needs Cloud Console setup)
  - **@ Continue with Email** → opens the existing email login/register modal (with CAPTCHA)
  - **𝕏 Continue with X** → "coming soon" toast
  - Bottom legal line: "By continuing you agree to Terms and Privacy Policy" (both open the real in-app modals)
- ✅ Email/password login flow unchanged and fully working behind the new screen.

## What's new in Phase 9 — Grok-style Redesign 🚀

**Ask / Imagine tabs** (like Grok's Ask / Imagine):
- ✅ **Ask tab** — full chat interface: user bubbles (right), plain AI messages (left), typing indicator, bottom input bar with 📎 attach, 🎤 voice, ➤ send
- ✅ **Free AI chat** — `POST /api/chat` proxies Pollinations text API (free, no key); 50 chats/day per account; history saved per user in `chat.json`
- ✅ **📚 Study Mode** — toggle in the Ask tab; AI becomes an expert tutor: direct answer first, step-by-step explanation, concrete example, key takeaways, follow-up question. Quick prompts: "Explain a concept", "Solve a problem", "Summarize a topic"
- ✅ **Image attach in chat** — upload a photo (diagram, graph, handwritten problem); best-effort vision via Pollinations OpenAI-compatible endpoint, honest fallback to text-only if unavailable
- ✅ **Chat history** — `GET /api/chat/history`, `DELETE /api/chat/history` (✎ New chat button); per-user, capped at 100 messages
- ✅ **Imagine tab** — all existing generation, plus:
  - **Trending styles** — horizontal scrollable cards (Chibi, Photoreal, Anime, Cyberpunk, Oil Paint, Pixel Art, Sketch, Fantasy); tap to auto-apply the style to your prompt
  - **Reference photo upload** — upload a photo, describe the transformation, generate the restyle
- ✅ **Pure-black Grok-style theme** — #000 background, rounded bubbles, minimal premium feel (light mode still available via toggle)
- ✅ **🎁 Referral program** — every account gets a unique 8-char code + link (`/?ref=CODE`); new signup with a valid code gives **+5 images / +3 videos to BOTH** referrer and newcomer; `GET /api/referrals` (code, link, total referrals, credits earned); "🎁 Refer & Earn" in the hamburger menu with copy + social share buttons; pending code captured from `?ref=` URL and applied at registration
- ✅ **👁️ Show/hide password** — eye toggle on all password fields (login, register, change password, delete-account confirm, reset password)
- ✅ Slim credits strip under the top bar (images / videos / chats / ads); auth gate cards for logged-out users

## What's new in Phase 8 — Professional Features 🌟

- ✅ **Forgot password** — "Forgot password?" link on the login modal; `POST /api/forgot-password` creates a 30-min one-time reset token (demo mode returns it in the response; production would email it); `POST /api/reset-password` sets the new password and revokes all sessions; always returns a generic message for unknown emails (no account enumeration); reset tokens are single-use
- ✅ **Cookie consent banner** — bottom banner ("🍪 We use cookies..."), Accept/Decline buttons, choice stored in `localStorage` (`aas_cookie_consent`), links to the Privacy Policy
- ✅ **Pricing page** — hamburger menu → 💎 Pricing modal: Free plan card ($0/forever, 6 images + 3 videos/day, ads for extras, notebook) vs Pro card ($9/month, coming soon, unlimited, HD, priority, no ads); responsive 2-col → 1-col grid
- ✅ **Dark / Light mode** — ☀️/🌙 toggle button top-right, full light-theme override set, preference persisted in `localStorage` (`aas_theme`, default dark), shifts down when the notification bar shows
- ✅ **Social share buttons** — after each generation: 𝕏 Post, Facebook, WhatsApp, 🔗 Copy Link, and native 📤 Share (Web Share API, shares the actual image/video file where supported; falls back to link share); native button auto-hidden where unsupported
- ✅ **Newsletter signup** — footer form (email + Subscribe); `POST /api/newsletter` (public, validates email, dedupes, stored in `newsletter.json`); success/error toasts
- ✅ **API documentation** — hamburger menu → ⌨️ API Docs modal documenting every endpoint (auth, generation, credits, ads, feedback, creations, newsletter, health) with method badges and request/response notes
- ✅ **Professional footer** — link bar (Pricing, API Docs, Privacy Policy, Terms of Service, Help/FAQ, Contact Us, About, Feedback), newsletter form, and © 2026 copyright line
- ✅ **Forgot modal** also added to the Escape-key close list alongside the pricing/API-docs modals

## What's new in Phase 7 — Feedback 💬 + My Creations 📓

- ✅ **💬 Feedback** — in the hamburger menu and footer; 5-star rating + comment box; `POST /api/feedback` (auth required, validates 1–5 stars and non-empty text); `GET /api/feedback` returns the user's own feedback newest-first; "🙏 Thank you for your feedback!" toast on success; stored in `feedback.json` (gitignored, ephemeral on free hosting)
- ✅ **📓 My Creations (notebook)** — in the hamburger menu; generation history grid with type badge (🖼️ IMAGE / 🎬 VIDEO), prompt, date, and params (size / duration + motion); `GET /api/my-creations` (auth required, newest first, capped at 100 per user); every successful generation is logged to `creations.json` via `recordCreation()`; **"🔁 Regenerate"** button loads the prompt back into the right tab for one-tap re-runs; actual files are not stored (they stream on-demand) — documented honestly in the UI
- ✅ **Account deletion cleanup** — deleting an account also removes its feedback entries, creations history, and usage records

## What's new in Phase 6 — Menu 🍔, CAPTCHA 🔒, Branding, Voice 🎤

- ✅ **Hamburger menu (☰)** top-left — slide-out drawer with Home, Settings, Privacy Policy, Terms of Service, Help/FAQ, Contact Us, About
- ✅ **Settings modal** — change password, delete account (double-confirm), shows signed-in email
- ✅ **Math CAPTCHA on login/register** — free, self-hosted (`GET /api/captcha`), one-time use, 5-min expiry; branded **"🔒 Secured by Ayaz AI Studio"**
- ✅ **Notification bar** — fixed top announcement bar, dismissible (✕), dismissal persisted in `localStorage` (keyed to the message, so a new message re-appears); message edited via the `NOTICE_MSG` JS variable at the top of the script
- ✅ **Voice input 🎤** — mic buttons next to both prompt textareas (image + video); uses Web Speech API (`en-US`); "Listening..." state; graceful fallback hides the buttons where unsupported
- ✅ **Professional dark-navy theme** — OpenAI/Runway-style, no purple

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
- `POST /api/register` `{ "email":"a@b.com", "password":"secret123", "captchaId":"...", "captchaAnswer":"12" }` → `201 { email, needsVerification: true, demoCode: "123456" }` (demo mode returns the code; production: emailed)
  - 400: invalid email / password < 6 chars / wrong CAPTCHA (`code: "captcha_failed"`) · 409: email already registered
- `POST /api/verify-email` `{ "email":"a@b.com", "code":"123456" }` → `{ token, email, credits }` — verifies the account, awards pending referral bonus
  - 400: wrong/expired code (`code: "code_invalid"` / `"code_expired"`) · 404: account not found
- `POST /api/resend-verification` `{ "email":"a@b.com" }` → `{ email, demoCode: "654321" }` — rate-limited: 5/hour per email (429)
- `POST /api/login` `{ "email":"a@b.com", "password":"secret123", "captchaId":"...", "captchaAnswer":"12" }` → `{ token, email, credits }`
  - 400: wrong CAPTCHA · 401: invalid email or password · 403: email not verified (`code: "email_not_verified"`)
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

**Feedback** (auth)
- `POST /api/feedback` `{ "rating": 5, "text": "Amazing app!" }` → `201 { ok: true, message: "Thank you for your feedback!" }`
  - 400: rating missing/not 1–5, or text empty (>1000 chars truncated)
- `GET /api/feedback` → `{ "feedback": [{ "email","rating","text","createdAt" }] }` — user's own feedback, newest first

**My Creations** (auth)
- `GET /api/my-creations` → `{ "creations": [{ "type":"image"|"video", "prompt", "params", "createdAt" }] }` — newest first, capped at 100 per user
- Every successful generation is logged automatically; account deletion wipes the history too
- Note: the media files themselves are not stored — entries keep prompt + params so "🔁 Regenerate" can re-run them

**Health** — `GET /api/health` → `{ ok, hfFallback, video, auth, passwordReset, newsletter, adProvider, adsPerDay, adReward }`

**Password reset**
- `POST /api/forgot-password` `{ "email":"a@b.com" }` → `{ ok: true, message, demoToken? }` — always returns the generic message for unknown emails (no enumeration); demo mode returns the 30-min token in `demoToken`
- `POST /api/reset-password` `{ "token":"...", "newPassword":"secret123" }` → `{ ok: true }` — new password min 6 chars; invalid/expired token → 400; all sessions revoked on success

**Newsletter**
- `POST /api/newsletter` `{ "email":"fan@example.com" }` → `201 { ok: true, message }` — public, validates email, ignores duplicates gracefully; stored in `newsletter.json`

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
2. **File-based accounts.** `users.json`/`usage.json` reset when Render's free tier sleeps/restarts (ephemeral filesystem). No email verification for password resets (demo mode returns the token), no login rate limiting — production needs Supabase Postgres + Supabase Auth (or Better Auth) + a real email service.
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
├── server.js          # Express backend: auth, image/video APIs, limits, rewarded ads, feedback, creations
├── package.json       # npm start, Node >= 18
├── render.yaml        # Render Blueprint (auto ffmpeg install)
├── .gitignore         # node_modules, .env, users/usage/feedback/creations/newsletter.json never committed
├── users.json         # (created at runtime) hashed accounts + sessions + reset tokens — gitignored
├── usage.json         # (created at runtime) daily usage + ad watches per email — gitignored
├── feedback.json      # (created at runtime) user feedback entries — gitignored
├── creations.json     # (created at runtime) generation history per email — gitignored
├── newsletter.json    # (created at runtime) newsletter subscribers — gitignored
├── public/
│   └── index.html     # Mobile-friendly English UI: auth modal + forgot password, theme toggle, cookie banner, credits, image/video tabs, ad modal, share row, pricing/API-docs/footer modals, newsletter form, toast
├── sample-output.jpg  # Proof: real generated image
└── sample-output-video.mp4  # Proof: real generated video (3s)
```
