"""HTTP API.

The server is stateless: it parses, compares and briefs the AI, but keeps no
runs. The browser stores runs (IndexedDB) and sends the ones it wants
compared with each request. That is what lets the same code run on a
serverless platform with a read-only filesystem and no database, and keeps
each visitor's runs private to their own browser.
"""

from __future__ import annotations

import hmac
import os
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import coach, focus, insights as insights_mod, keypool, legacy, mx_client, net, nim_client, ratelimit, tmio_client
from .coach_knowledge import COACH_SYSTEM_PROMPT
from .compare import compare_runs
from .gbx_parser import GbxParseError, parse_gbx_bytes

load_dotenv()

ON_VERCEL = bool(os.environ.get("VERCEL"))
PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"
# Vercel rejects request bodies over 4.5 MB before our code runs; stay under it
# so the error is ours and readable. Locally there's no such limit.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES") or (4_300_000 if ON_VERCEL else 40_000_000))


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except ValueError:
        return default


# Rate limits (0 = unlimited). The defaults protect a public deployment's AI
# keys; locally they are off unless you set them.
AI_LIMIT_PER_HOUR = _env_int("AI_LIMIT_PER_HOUR", 5 if ON_VERCEL else 0)
AI_LIMIT_PER_DAY = _env_int("AI_LIMIT_PER_DAY", 20 if ON_VERCEL else 0)
AI_LIMIT_GLOBAL_PER_DAY = _env_int("AI_LIMIT_GLOBAL_PER_DAY", 0)
API_LIMIT_PER_MINUTE = _env_int("API_LIMIT_PER_MINUTE", 120 if ON_VERCEL else 0)

# The cheap per-minute brake on every API call counts in this process only (an
# extra network round trip on every request isn't worth it); the AI limits use
# the shared store when one is configured.
_burst_limiter = ratelimit.RateLimiter(ratelimit.MemoryBackend())


def _visitor(request: Request) -> str:
    ip = ratelimit.client_ip(request.headers, request.client.host if request.client else None)
    return ratelimit.RateLimiter.visitor_id(ip)


def require_access(request: Request) -> None:
    """Optional shared-secret gate: set ACCESS_CODE and every /api call must
    carry it (the browser sends the code saved in Settings). Keeps strangers
    from spending the owner's NVIDIA key or CPU on a public deployment."""
    required = os.environ.get("ACCESS_CODE", "").strip()
    path = request.url.path
    if not required or not path.startswith("/api/") or path == "/api/health":
        return
    supplied = request.headers.get("x-access-code", "")
    if not hmac.compare_digest(supplied.encode(), required.encode()):
        raise HTTPException(401, "This site needs an access code — enter it in Settings.")


def api_rate_limit(request: Request) -> None:
    path = request.url.path
    if API_LIMIT_PER_MINUTE <= 0 or not path.startswith("/api/") or path == "/api/health":
        return
    hit = _burst_limiter.check("api", _visitor(request), API_LIMIT_PER_MINUTE, 60)
    if not hit.allowed:
        raise HTTPException(429, "Too many requests - slow down a little.", headers={"Retry-After": str(hit.retry_after)})


app = FastAPI(
    title="Trackmania AI Run Analyzer",
    dependencies=[Depends(require_access), Depends(api_rate_limit)],
    docs_url=None, redoc_url=None, openapi_url=None,
)
app.add_middleware(GZipMiddleware, minimum_size=1000)


# ------------------------------------------------------------------ models

class Sample(BaseModel):
    time_ms: int
    x: float
    y: float
    z: float
    speed: float
    steer: float
    gas: float
    brake: float


class RunPayload(BaseModel):
    id: str = Field(max_length=64)
    map_uid: str | None = None
    map_name: str | None = None
    player_nickname: str | None = None
    race_time_ms: int | None = None
    world_position: int | None = None
    samples: list[Sample] = Field(default_factory=list, max_length=60_000)

    def as_run(self) -> dict:
        return {
            "id": self.id,
            "map_uid": self.map_uid,
            "map_name": self.map_name,
            "player_nickname": self.player_nickname,
            "race_time_ms": self.race_time_ms,
            "world_position": self.world_position,
            "samples": [s.model_dump() for s in self.samples],
        }


class CompareRequest(BaseModel):
    subject: RunPayload
    references: list[RunPayload] = Field(max_length=6)


class AnalyzeRequest(BaseModel):
    subject: RunPayload
    reference: RunPayload
    account_id: str | None = None
    history: dict | None = None
    previous: dict | None = None
    depth: str | None = None


def _label(run: dict, fallback: str) -> str:
    return run.get("player_nickname") or fallback


def _downsample(points: list[dict], target: int) -> list[dict]:
    if len(points) <= target:
        return points
    step = len(points) / target
    return [points[int(i * step)] for i in range(target)]


# ------------------------------------------------------------------ health

@app.get("/api/health")
def health():
    pool = keypool.get_pool()
    return {
        "ok": True,
        "platform": "vercel" if ON_VERCEL else "local",
        "ai_keys": len(pool),
        "server_has_ai_key": len(pool) > 0,
        "ai_limits": {"per_hour": AI_LIMIT_PER_HOUR, "per_day": AI_LIMIT_PER_DAY},
        "rate_limit_backend": ratelimit.get_limiter().backend.name,
        "access_code_required": bool(os.environ.get("ACCESS_CODE", "").strip()),
        "admin_code_supported": bool(os.environ.get("ADMIN_CODE", "").strip()),
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "max_body_bytes": 4_500_000 if ON_VERCEL else None,
        "depths": [{"id": k, "label": v["label"]} for k, v in coach.DEPTHS.items()],
        "default_depth": coach.DEFAULT_DEPTH,
    }


# --------------------------------------------------- importing runs (stateless)

def _run_record(
    data: bytes, *, kind: str, source: str, filename: str,
    map_uid_hint: str | None = None, nickname_hint: str | None = None,
    race_time_hint: int | None = None, world_position: int | None = None,
) -> dict:
    """Parse Gbx bytes into a run record for the browser to keep. Ghosts
    downloaded from trackmania.io often have no header metadata, so hints
    from the leaderboard entry that pointed at them fill in the gaps."""
    if kind not in ("run", "reference"):
        raise HTTPException(400, "kind must be 'run' or 'reference'")
    try:
        parsed = parse_gbx_bytes(data)
    except GbxParseError as e:
        raise HTTPException(400, f"could not read '{filename}': {e}") from e

    map_uid = parsed.map_uid or map_uid_hint
    if not map_uid:
        raise HTTPException(400, f"'{filename}' doesn't look like a Trackmania replay or ghost")
    try:
        net.valid_map_uid(map_uid)
    except ValueError:
        raise HTTPException(400, f"'{filename}' has an unexpected map id") from None

    return {
        "id": uuid.uuid4().hex[:12],
        "map_uid": map_uid,
        "map_name": parsed.map_name,
        "player_nickname": parsed.player_nickname or nickname_hint,
        "race_time_ms": parsed.race_time_ms if parsed.race_time_ms is not None else race_time_hint,
        "kind": kind,
        "source": source,
        "world_position": world_position,
        "source_filename": filename,
        "uploaded_at": time.time(),
        "telemetry_available": parsed.telemetry_available,
        "samples": parsed.samples,
    }


@app.post("/api/runs")
async def upload_run(file: UploadFile = File(...), kind: str = Form("run")):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, f"'{file.filename}' is larger than this server accepts ({MAX_UPLOAD_BYTES / 1e6:.1f} MB). "
                 "Import it from ManiaExchange or trackmania.io instead, or run the app locally."
        )
    return _run_record(data, kind=kind, source="upload", filename=file.filename or "upload.Gbx")


@app.post("/api/mx/import-replay")
def mx_import_replay(map_uid: str = Form(...), mx_replay_id: int = Form(...), kind: str = Form("reference")):
    try:
        data = mx_client.download_replay_bytes(mx_replay_id)
    except mx_client.MxError as e:
        raise HTTPException(502, str(e)) from e
    return _run_record(
        data, kind=kind, source="mx", filename=f"mx-replay-{mx_replay_id}.Gbx", map_uid_hint=map_uid,
    )


@app.post("/api/tmio/import-ghost")
def tmio_import_ghost(
    map_uid: str = Form(...),
    ghost_ref: str = Form(...),
    kind: str = Form("reference"),
    player_nickname: str | None = Form(None),
    race_time_ms: int | None = Form(None),
    world_position: int | None = Form(None),
):
    try:
        data = tmio_client.download_ghost_bytes(ghost_ref)
    except tmio_client.TmioError as e:
        raise HTTPException(502, str(e)) from e
    return _run_record(
        data, kind=kind, source="tmio", filename=f"tmio-ghost-{world_position or 'x'}.Gbx",
        map_uid_hint=map_uid, nickname_hint=player_nickname,
        race_time_hint=race_time_ms, world_position=world_position,
    )


@app.get("/api/legacy-runs")
def legacy_runs():
    """Runs saved by the old server-side-storage version (local use only)."""
    return [] if ON_VERCEL else legacy.load_legacy_runs()


# ------------------------------------------------------------------ comparing

@app.post("/api/compare")
def compare(body: CompareRequest):
    """One subject run against several references. Every comparison reuses
    the subject's samples, so each result shares the same distance axis and
    the frontend can overlay them directly."""
    subject = body.subject.as_run()
    out = {}
    for ref in body.references:
        reference = ref.as_run()
        result = compare_runs(subject, reference)
        found = focus.find_focus(result.stats, result.corners, result.sections)
        out[ref.id] = {
            "reference_label": _label(reference, "ghost"),
            "points": result.points,
            "stats": result.stats,
            "corners": result.corners,
            "sections": result.sections,
            "focus": found["focus"],
            "strengths": found["strengths"],
        }
    return out


def _is_admin(code: str | None) -> bool:
    required = os.environ.get("ADMIN_CODE", "").strip()
    return bool(required) and bool(code) and hmac.compare_digest(code.encode(), required.encode())


def _consume_ai_quota(request: Request) -> list[tuple[str, int, ratelimit.Hit]]:
    """Count this analysis against the visitor's hourly and daily allowance
    (and the optional site-wide daily budget). Raises 429 if any is used up."""
    limiter = ratelimit.get_limiter()
    visitor = _visitor(request)
    checks = [
        ("ai-hour", visitor, AI_LIMIT_PER_HOUR, 3600, "this hour"),
        ("ai-day", visitor, AI_LIMIT_PER_DAY, 86400, "today"),
        ("ai-global", "all", AI_LIMIT_GLOBAL_PER_DAY, 86400, "across the whole site today"),
    ]
    hits: list[tuple[str, int, ratelimit.Hit]] = []
    for scope, who, limit, window, label in checks:
        if limit <= 0:
            continue
        hit = limiter.check(scope, who, limit, window)
        if not hit.allowed:
            for _, _, earlier in hits:
                earlier.refund()
            minutes = max(1, -(-hit.retry_after // 60))
            wait = f"{minutes} minute{'s' if minutes != 1 else ''}" if minutes < 120 else f"{-(-minutes // 60)} hours"
            if scope == "ai-global":
                detail = ("The site's shared AI allowance for today is used up. Try again later, "
                          "or paste your own NVIDIA key in Settings to keep going.")
            else:
                detail = (f"You've used your {limit} free AI analyses {label}. Try again in about {wait}, "
                          "or paste your own NVIDIA key in Settings for unlimited use.")
            raise HTTPException(429, detail, headers={"Retry-After": str(hit.retry_after)})
        hits.append((scope, limit, hit))
    return hits


@app.post("/api/analyze")
def analyze(
    request: Request,
    body: AnalyzeRequest,
    x_nim_key: str | None = Header(None),
    x_admin_code: str | None = Header(None),
):
    using_pool = not (x_nim_key or "").strip()
    if using_pool and len(keypool.get_pool()) == 0:
        raise HTTPException(
            400,
            "No NVIDIA NIM API key is available. The site owner needs to set NVIDIA_NIM_API_KEYS "
            "(or NVIDIA_NIM_API_KEY), or you can paste your own key into Settings.",
        )

    subject, reference = body.subject.as_run(), body.reference.as_run()
    result = compare_runs(subject, reference)
    found = focus.find_focus(result.stats, result.corners, result.sections)
    map_uid = subject.get("map_uid") or reference.get("map_uid")

    insights = None
    if map_uid:
        try:
            insights = insights_mod.gather(
                map_uid, race_time_ms=subject.get("race_time_ms"), account_id=body.account_id,
            )
        except (ValueError, KeyError):
            insights = None

    reference_label = _label(reference, "ghost")
    map_name = subject.get("map_name") or ((insights or {}).get("map") or {}).get("name")
    cfg = coach.depth_config(body.depth)
    depth = body.depth if body.depth in coach.DEPTHS else coach.DEFAULT_DEPTH
    prompt = coach.build_user_prompt(
        map_name=map_name,
        subject_label=_label(subject, "player"),
        reference_label=reference_label,
        stats=result.stats,
        sample_points=_downsample(result.points, 24),
        corners=result.corners,
        sections=result.sections,
        history=body.history or {},
        insights=insights,
        previous=body.previous,
        reference_world_position=reference.get("world_position"),
        focus=found,
        depth=depth,
    )

    # Count the analysis only when it uses the server's keys (a visitor's own
    # key is their own cost), and hand it back if the AI call fails.
    hits = [] if (not using_pool or _is_admin(x_admin_code)) else _consume_ai_quota(request)
    try:
        text = nim_client.analyze(
            COACH_SYSTEM_PROMPT, prompt, user_key=x_nim_key,
            params=nim_client.AnalysisParams(max_tokens=cfg["max_tokens"], reasoning_budget=cfg["reasoning_budget"]),
        )
    except nim_client.NimConfigError as e:
        _refund(hits)
        raise HTTPException(400, str(e)) from e
    except nim_client.NimBusyError as e:
        _refund(hits)
        raise HTTPException(503, str(e), headers={"Retry-After": str(e.retry_after)}) from e
    except nim_client.NimRequestError as e:
        _refund(hits)
        raise HTTPException(502, str(e)) from e

    text = coach.clean_report(text)
    quota = None
    if hits:
        quota = {scope: {"limit": limit, "remaining": hit.remaining} for scope, limit, hit in hits}
    return {
        "analysis": text,
        "stats": result.stats,
        "insights": insights,
        "quota": quota,
        "depth": depth,
        "memory": coach.build_memory(
            stats=result.stats, corners=result.corners, sections=result.sections,
            analysis_text=text, reference_label=reference_label,
        ),
    }


def _refund(hits) -> None:
    for _, _, hit in hits:
        hit.refund()


# ------------------------------------------------- ManiaExchange / trackmania.io

def _mx_map_summary(m: dict) -> dict:
    return {
        "map_id": m["MapId"],
        "map_uid": m.get("MapUid"),
        "name": m.get("Name"),
        "authors": [a["User"]["Name"] for a in m.get("Authors", [])],
        "tags": [t["Name"] for t in m.get("Tags", [])],
        "difficulty": m.get("Difficulty"),
        "award_count": m.get("AwardCount"),
        "replay_count": m.get("ReplayCount"),
        "thumbnail_url": mx_client.thumbnail_url(m["MapId"]),
    }


@app.get("/api/mx/search")
def mx_search(name: str | None = None, tag: str | None = None, count: int = 24):
    try:
        return [_mx_map_summary(m) for m in mx_client.search_maps(name=name, tag=tag, count=count)]
    except mx_client.MxError as e:
        raise HTTPException(502, str(e)) from e


@app.get("/api/mx/maps/{map_uid}")
def mx_map_detail(map_uid: str):
    try:
        m = mx_client.get_map_by_uid(map_uid)
    except mx_client.MxError as e:
        raise HTTPException(502, str(e)) from e
    if not m:
        raise HTTPException(404, "map not found on ManiaExchange")
    try:
        replays = mx_client.list_replays(m["MapId"], count=20)
    except mx_client.MxError:
        replays = []
    return {
        **_mx_map_summary(m),
        "replays": [
            {
                "replay_id": r["ReplayId"],
                "player_name": r.get("User", {}).get("Name"),
                "time_ms": r.get("ReplayTime"),
                "position": r.get("Position"),
                "has_file": r.get("HasFile", False),
            }
            for r in replays
        ],
    }


@app.get("/api/tmio/players/search")
def tmio_player_search(name: str):
    try:
        players = tmio_client.search_players(name)
    except tmio_client.TmioError as e:
        raise HTTPException(502, str(e)) from e
    return [
        {
            "account_id": p["id"],
            "name": p["name"],
            "zone_name": (p.get("zone") or {}).get("name"),
            "zone_flag": (p.get("zone") or {}).get("flag"),
        }
        for p in players
    ]


@app.get("/api/tmio/players/{account_id}")
def tmio_player_profile(account_id: str):
    try:
        profile = tmio_client.get_player(account_id)
    except tmio_client.TmioError as e:
        raise HTTPException(502, str(e)) from e
    return {
        "account_id": account_id,
        "name": profile.get("displayname"),
        "club_tag": profile.get("clubtag"),
        "trophy_points": (profile.get("trophies") or {}).get("points"),
        "zones": tmio_client.zone_standing(profile),
    }


@app.get("/api/tmio/maps/{map_uid}/leaderboard")
def tmio_leaderboard(map_uid: str, length: int = 20):
    try:
        net.valid_map_uid(map_uid)
    except ValueError:
        raise HTTPException(400, "invalid map uid") from None
    return insights_mod.world_leaderboard(map_uid, length=length)


@app.get("/api/insights")
def get_insights(map_uid: str, race_time_ms: int | None = None, account_id: str | None = None):
    try:
        net.valid_map_uid(map_uid)
    except ValueError:
        raise HTTPException(400, "invalid map uid") from None
    return insights_mod.gather(map_uid, race_time_ms=race_time_ms, account_id=account_id)


# Locally FastAPI serves the frontend itself. On Vercel the platform serves
# public/ from its CDN (and asks us not to mount it), so this stays off there.
if not ON_VERCEL and PUBLIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")
