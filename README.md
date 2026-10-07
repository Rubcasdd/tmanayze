# Trackmania AI Analyzer

Compare your Trackmania 2020 run against any ghost — the world record, a friend,
your own PB — and see exactly where the time goes: speed and **steering overlaid
on the same graphs, split into track sections**, a corner-by-corner breakdown
(time gained/lost, entry/min/exit speed, braking point, steering), and an AI
coach that works from those measurements.

- **My maps front page:** add your `Documents\Trackmania\Replays\Autosaves` folder
  (drop it on the page) and every map you've finished appears with your best time.
  Pick one to open it.
- **Full-width analysis:** large graphs that share one crosshair (speed, time gap,
  speed difference, steering, brake/throttle), a colour-coded track map, per-section
  charts, and a corner table. Every graph has an Expand button, and the workspace can
  go full screen.
- **Full world leaderboard:** page through every player, jump to a rank, or find where
  your own time sits (the board is searched by time, so it works on any map).
- **What to focus on:** ranked, titled focus areas ("Carry more speed through the
  hairpin at 1882–2032 m") with the measured evidence and the time at stake, plus
  the stretches you're already good at.
- Search a username for their profile and zone standing.
- Find a map (ManiaExchange), see its world leaderboard, and import the top
  ghosts or community replays with one click — or upload your own `.Gbx`.
- AI coaching with a choice of detail (Concise / Detailed / Very detailed).
- Your runs are saved **in your browser**, not on a server.
- The coach remembers its last session on a map and checks whether you improved.

## Run it locally

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt     # macOS/Linux: .venv/bin/pip
copy .env.example .env                            # then put your NVIDIA key in .env
.venv\Scripts\uvicorn backend.main:app --reload
```

Open http://127.0.0.1:8000. Get an NVIDIA NIM key at https://build.nvidia.com.
Keep real keys in `.env` only — it is git-ignored; `.env.example` is the shareable template.

## Deploy to Vercel (step by step)

The app is a FastAPI function plus a static `public/` folder; Vercel detects it
with no build step. You need a free account at https://vercel.com/signup.

### Option A — Vercel CLI (fastest, no GitHub needed)

1. Install Node.js (https://nodejs.org), then in a terminal: `npm i -g vercel`
2. Open the project folder in the terminal and run `vercel login` (it opens your
   browser to sign in).
3. Run `vercel`. Answer: *Set up and deploy?* **Y** → pick your account → *Link to
   existing project?* **N** → accept the project name → directory `./` → it
   detects FastAPI; *override settings?* **N**. You get a preview URL.
4. Add your settings (each command asks you to paste the value):
   ```bash
   vercel env add NVIDIA_NIM_API_KEYS production     # your key(s), comma-separated
   vercel env add ACCESS_CODE production             # optional: a password for the site
   vercel env add ADMIN_CODE production              # optional: lets *you* skip the AI limits
   ```
5. Run `vercel --prod`. It prints your live address, e.g.
   `https://trackmania-ai-analyzer-xxxx.vercel.app`. Environment variables only
   apply to deployments made *after* you add them, so always redeploy.

### Option B — GitHub (auto-deploys every time you push)

1. Create an empty repository on github.com (private is fine).
2. In the project folder:
   ```bash
   git init
   git add .
   git status          # check that .env, .env.txt, data/ and .venv are NOT listed
   git commit -m "Trackmania AI Analyzer"
   git branch -M main
   git remote add origin https://github.com/YOU/REPO.git
   git push -u origin main
   ```
3. On vercel.com choose **Add New → Project**, import the repository, open
   **Environment Variables**, add the names from the table below, and click
   **Deploy**.
4. From then on, every `git push` redeploys the site.

### Then

Open your URL, click **⚙ Settings** (enter your access/admin code if you set
them), and try it: find a map → import a ghost → compare → **Analyze with AI**.

### Environment variables

| Name | Purpose |
|---|---|
| `NVIDIA_NIM_API_KEYS` | One or more NVIDIA NIM keys (comma, space or new-line separated). Each AI request uses the next key in rotation; if one is throttled or rejected the request moves to another. `NVIDIA_NIM_API_KEY` (one key) also works. Optional: visitors can paste their own in **Settings** instead. |
| `AI_LIMIT_PER_HOUR`, `AI_LIMIT_PER_DAY` | Free AI analyses per visitor (defaults on Vercel: **5/hour, 20/day**; `0` = unlimited). Visitors who paste their own key aren't limited. |
| `AI_LIMIT_GLOBAL_PER_DAY` | Optional cap on all visitors combined per day, to protect your keys' quota. |
| `API_LIMIT_PER_MINUTE` | Per-visitor cap on API calls per minute (default 120 on Vercel). |
| `ADMIN_CODE` | Enter it in **Settings** to skip the AI limits yourself. |
| `ACCESS_CODE` | If set, every `/api` call needs this code (visitors enter it in **Settings**) — a password for the whole site. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Shared counter store so rate limits are exact (see below). `KV_REST_API_URL` / `KV_REST_API_TOKEN` work too. |
| `API_CONTACT` | Appended to the User-Agent sent to ManiaExchange / trackmania.io (they ask for an identifiable agent). |
| `TMIO_API_KEY` | Free trackmania.io key for a higher rate limit. |
| `NIM_MODEL`, `NIM_URL` | Use a different NIM model or a self-hosted endpoint. |

### AI keys and rate limits

- **Key pool.** Put several keys in `NVIDIA_NIM_API_KEYS`. Requests rotate through
  them one at a time, spreading load across each key's own free-tier limits. A key
  that NVIDIA rate-limits (429) is benched for 45 s, one it rejects (401) for an
  hour, and the request moves straight on to the next key. Keys are never sent to
  the browser or logged.
- **Capacity is shared.** NVIDIA's free tier also runs out of worker capacity for
  *everyone* at once; that isn't fixed by more keys. The app backs off and retries
  a few times, then shows a friendly "at capacity, try again" message and does not
  count the attempt against the visitor's allowance.
- **Per-visitor limits** are on by default on Vercel (5/hour, 20/day; visitors are
  identified by a hash of their IP, never stored raw). Out of the box each serverless
  instance counts on its own, so a determined visitor could exceed the limit across
  instances. For exact limits add **Upstash for Redis**: Vercel dashboard →
  **Storage** → **Create** → *Upstash for Redis* → connect it to the project →
  redeploy. It sets the `KV_REST_API_*` variables, which the app picks up
  automatically (the Settings panel and `/api/health` report which backend is
  active). If that store is ever unreachable, the limiter falls back to
  per-instance counting instead of blocking everyone.
- **Detail level** (Concise / Detailed / Very detailed) controls how much the AI is
  asked for and how long it may think and write.

### Things to know on Vercel

- **Nothing is stored server-side.** Runs live in each visitor's browser
  (IndexedDB) and are sent along with each comparison request, so the
  read-only filesystem and lack of a database don't matter, and visitors never
  see each other's runs. Clearing site data removes them.
- **Request size limit: 4.5 MB.** Uploads above ~4.3 MB are refused with a clear
  message (import big replays from ManiaExchange / trackmania.io instead —
  those download server-side, so the limit doesn't apply). Comparing several
  ghosts at once sends all their telemetry; the page warns if it gets too big.
- **Duration.** A "Very detailed" AI analysis can take a few minutes. Functions
  default to 300 s on current plans; the app stops waiting at 270 s and returns
  whatever the AI has written so far rather than failing.
- **Python version** is Vercel's default (3.12); the code runs on 3.12+.
- **Troubleshooting.** *Build can't find the app:* make sure `pyproject.toml` is in
  the deployed folder. *Env var change has no effect:* redeploy. *"Too large"
  errors:* import instead of uploading, or compare fewer ghosts at once.

## How it works

- `backend/gbx_parser.py` — self-contained Gbx parser: header metadata and the
  ~50 ms vehicle telemetry (position, speed, steering, gas, brake), including
  the newer columnar delta-encoded format used by current ghosts. Uses a
  vendored pure-Python LZO decompressor (`lzo1x.py`) since the C `python-lzo`
  won't build on most machines or serverless platforms.
- `backend/compare.py` — aligns two runs by position (interpolating between
  samples, so the time gap is smooth rather than stepped in 50 ms jumps) and
  produces the whole-track traces, **corners** (detected from the ghost's true
  path curvature, not noisy steering input), equal-distance **sections** with
  full-resolution traces, steering metrics, and an alignment check that warns
  when two runs don't follow the same route.
- `backend/focus.py` — ranks the titled focus areas from the measured
  corners/sections (deterministic, no AI, so they always match the charts).
- `backend/keypool.py`, `ratelimit.py` — the rotating key pool and per-visitor limits.
- `backend/coach.py`, `coach_knowledge.py`, `nim_client.py` — builds the
  coaching prompt (measured corners/sections/steering, map tags, leaderboard and
  zone context, the last session's notes) with a Trackmania coaching knowledge
  base, and calls NVIDIA NIM.
- `backend/mx_client.py`, `tmio_client.py`, `net.py` — ManiaExchange and
  trackmania.io clients (no keys needed). Every id that becomes part of an
  outbound URL is validated and downloads are size-capped.
- `public/` — the site (vanilla JS + Chart.js, no build step). `store.js` is the
  browser-side storage.

## Limits

- Corner detection finds stretches where the ghost's path curves (~95 m radius or
  tighter); on a mostly straight map there may only be a few.
- Left/right labels assume the usual convention (+1 steering = right), which
  matched the path geometry on real runs.
- "Input device" (keyboard vs pad) is inferred from steering values — an estimate.
- Some replays carry no per-tick telemetry; they compare by finish time only.
- Zone standing is trophy-based (what trackmania.io exposes without Nadeo OAuth);
  world position is exact only within the top 50.
- The telemetry formats are community-documented; a future game update could
  change them.
