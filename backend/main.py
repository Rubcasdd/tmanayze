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
import hashlib
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import coach, focus, insights as insights_mod, keypool, legacy, mx_client, net, nim_client, ratelimit, surface as surface_mod, tmio_client
from . import blueprint as blueprint_mod, checkpoints as checkpoints_mod, coach_knowledge, landmarks as landmarks_mod, playbook as playbook_mod, driving as driving_mod, shares, signals as signals_mod, skills as skills_mod, techniques
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
    # the car's orientation, when the run was parsed with it (older stored runs don't have it)
    fx: float | None = None
    fy: float | None = None
    fz: float | None = None
    ux: float | None = None
    uy: float | None = None
    uz: float | None = None


class RunPayload(BaseModel):
    id: str = Field(max_length=64)
    checkpoints: list[int] | None = Field(default=None, max_length=200)  # the game's checkpoint times, finish last
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
            "checkpoints": self.checkpoints,
            "samples": [s.model_dump() for s in self.samples],
        }


class CompareRequest(BaseModel):
    tags: list[str] = Field(default_factory=list, max_length=40)  # the map's tags, to know what kind of map it is
    subject: RunPayload
    references: list[RunPayload] = Field(max_length=6)


class AnalyzeRequest(BaseModel):
    subject: RunPayload
    reference: RunPayload
    account_id: str | None = None
    history: dict | None = None
    previous: dict | None = None
    depth: str | None = None
    others: list[RunPayload] = Field(default_factory=list, max_length=3)  # more ghosts: the blueprint uses all of them


def _is_bob(tags: list[str] | None, share: dict | None) -> bool:
    """A bobsleigh or ice map: the tilted stretches there are the track's banked turns, not wall rides."""
    try:
        return any(s in ("bobsleigh", "ice") for s, _ in techniques.detect_styles(tags or [], None, share or {}))
    except Exception:
        return False


def _make_playbook(subject: dict, reference: dict, corners: list[dict], points: list[dict], lm, bp: dict | None,
                   tags: list[str], subject_driving: dict | None, subject_flights: list[dict], ref_flights: list[dict]) -> list[dict]:
    """The prepared tricks for this map, with where to use them. Never raises: a card list is only ever an extra."""
    try:
        samples = subject.get("samples") or []
        labels = _ground_labels(subject)
        share = surface_mod.summarize(labels) if labels else {}
        dist = signals_mod._cumulative_distance(samples) if len(samples) >= 20 else []
        corner_ground = surface_mod.corner_surfaces(labels, dist, corners) if labels and dist else {}
        s = signals_mod.analyze_run(samples)
        g = signals_mod.analyze_run(reference.get("samples") or [])
        _, _, ghost_only_taps = signals_mod.pair_items(s["taps"], g["taps"])
        _, player_only_lifts, _ = signals_mod.pair_items(s["lifts"], g["lifts"])
        styles = [st for st, _ in techniques.detect_styles(tags, None, share)]
        d = subject_driving or {}
        return playbook_mod.build(
            styles=styles, corners=corners, corner_ground=corner_ground, ground_share=share,
            flights_you=subject_flights, flights_ref=ref_flights, landings=d.get("landings") or [], walls=d.get("inverted") or [],
            ghost_taps=ghost_only_taps, player_lifts=[x for x in player_only_lifts if x["duration_s"] >= 0.25],
            points=points, lm=lm, blueprint=bp,
        )
    except Exception:
        return []


def reference_for(body, ref_id: str | None) -> dict:
    for r in body.references:
        if r.id == ref_id:
            return r.as_run()
    return {}


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
        "id": hashlib.sha1(data + kind.encode()).hexdigest()[:12],
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
        "checkpoints": parsed.checkpoint_times,
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
        raise _mx_http_error(e) from e
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

class SurfaceRequest(BaseModel):
    map_uid: str
    points: list[list[float]] = Field(max_length=4000)


@app.post("/api/surface")
def surface_for_points(body: SurfaceRequest):
    """What the car was driving on at each of these [x, y, z] points, from the map's blocks."""
    try:
        net.valid_map_uid(body.map_uid)
    except ValueError:
        raise HTTPException(400, "invalid map uid") from None
    pts = [(p[0], p[1], p[2]) for p in body.points if len(p) >= 3]
    sm = surface_mod.get_surface_map(body.map_uid)
    if sm is None or not pts:
        return {"available": False, "surfaces": [], "summary": {}}
    labels = sm.label(pts)
    return {
        "available": True,
        "surfaces": labels,
        "summary": surface_mod.summarize(labels),
        "labels": surface_mod.LABELS,
    }


@app.post("/api/blocks")
def blocks_near_line(body: SurfaceRequest):
    """The map's blocks around a driven line, for the 3D replay: shape family, grid cell, level and facing."""
    try:
        net.valid_map_uid(body.map_uid)
    except ValueError:
        raise HTTPException(400, "invalid map uid") from None
    pts = [(p[0], p[1], p[2]) for p in body.points if len(p) >= 3]
    sm = surface_mod.get_surface_map(body.map_uid)
    if sm is None or not pts:
        return {"available": False, "blocks": []}
    return sm.blocks_near(pts)


def _ground_labels(run: dict) -> list[str] | None:
    """The ground under each sample of a run (from the map's blocks), or None when it can't be had."""
    try:
        if not run.get("map_uid") or not run.get("samples"):
            return None
        return surface_mod.surfaces_for_samples(run["map_uid"], run["samples"])
    except Exception:
        return None


@app.post("/api/compare")
def compare(body: CompareRequest):
    """One subject run against several references. Every comparison reuses
    the subject's samples, so each result shares the same distance axis and
    the frontend can overlay them directly."""
    subject = body.subject.as_run()
    out = {}
    try:
        subject_flights = signals_mod.public_flights(subject.get("samples") or [])
    except Exception:  # jumps are a bonus; never break the comparison over them
        subject_flights = []
    try:  # the map's own checkpoints cut the track into sections, and give split times
        cp_info = checkpoints_mod.subject_passes(subject.get("samples") or [], subject.get("checkpoints"))
    except Exception:
        cp_info = None
    cp_bounds = checkpoints_mod.section_bounds(cp_info)
    try:
        _lab = _ground_labels(subject)
        bob_map = _is_bob(body.tags, surface_mod.summarize(_lab) if _lab else {})
    except Exception:
        bob_map = False
    try:
        subject_driving = driving_mod.analyze(subject.get("samples") or [], bob_map)
    except Exception:  # landings, wall-rides and smoothness are extras too
        subject_driving = None
    try:  # which driving skills the run uses, found once and compared with each reference below
        subject_samples = subject.get("samples") or []
        subject_skills = skills_mod.detect(subject_samples, _ground_labels(subject), bob_map)
        subject_dist = signals_mod._cumulative_distance(subject_samples) if len(subject_samples) >= 20 else []
    except Exception:
        subject_skills = None
    points_by_ref: dict[str, list] = {}
    flights_by_ref: dict[str, list] = {}
    for ref in body.references:
        reference = ref.as_run()
        result = compare_runs(subject, reference, cp_bounds)
        try:
            reference_flights = signals_mod.public_flights(reference.get("samples") or [])
        except Exception:
            reference_flights = []
        try:
            cp_rows = checkpoints_mod.rows(cp_info, reference.get("checkpoints")) if cp_info else []
        except Exception:
            cp_rows = []
        try:
            ref_driving = driving_mod.analyze(reference.get("samples") or [], bob_map)
        except Exception:
            ref_driving = None
        try:
            skills_report = skills_mod.compare(subject_skills, skills_mod.detect(reference.get("samples") or [], _ground_labels(reference), bob_map), subject_samples, subject_dist) if subject_skills else None
        except Exception:
            skills_report = None
        points_by_ref[ref.id] = result.points
        flights_by_ref[ref.id] = reference_flights
        found = focus.find_focus(result.stats, result.corners, result.sections)
        out[ref.id] = {
            "reference_label": _label(reference, "ghost"),
            "points": result.points,
            "stats": result.stats,
            "corners": result.corners,
            "sections": result.sections,
            "focus": found["focus"],
            "strengths": found["strengths"],
            "reference_path": result.reference_path,
            "subject_flights": subject_flights,
            "reference_flights": reference_flights,
            "driving": {"subject": subject_driving, "reference": ref_driving},
            "skills": skills_report,
            "checkpoints": cp_rows,
        }
    try:  # the steering of the references, metre by metre, against the player's
        first = body.references[0].id if body.references else None
        analog = str(out[first]["stats"].get("reference_input_style", "analog")).startswith("analog") if first else True
        lm = landmarks_mod.Landmarks(cp_info, out[first]["corners"], points_by_ref[first], out[first]["checkpoints"]) if first else None
        bp = blueprint_mod.build(points_by_ref, first, analog, lm) if first else None
    except Exception:
        bp, lm, first = None, None, None
    if bp:
        bp["lessons"] = blueprint_mod.lessons(bp, True)
    playbook = (
        _make_playbook(subject, reference_for(body, first), out[first]["corners"], points_by_ref[first], lm, bp, body.tags,
                       subject_driving, subject_flights, flights_by_ref.get(first, []))
        if first else []
    )
    for entry in out.values():
        entry["blueprint"] = bp
        entry["playbook"] = playbook
    try:  # what the ghosts share and the player doesn't (a different line, a jump line, an air-brake)
        moves = driving_mod.field_moves(points_by_ref, subject_flights, flights_by_ref)
    except Exception:
        moves = []
    for entry in out.values():
        entry["field_moves"] = moves
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
    try:
        cp_info = checkpoints_mod.subject_passes(subject.get("samples") or [], subject.get("checkpoints"))
    except Exception:
        cp_info = None
    result = compare_runs(subject, reference, checkpoints_mod.section_bounds(cp_info))
    found = focus.find_focus(result.stats, result.corners, result.sections)
    map_uid = subject.get("map_uid") or reference.get("map_uid")
    blueprint_data = None
    lm = None
    lessons_list: list[dict] = []
    how_to_cards: list[dict] = []
    field_text = ""
    if result.stats.get("telemetry"):
        try:
            pts = {"main": result.points}
            for k, other in enumerate(body.others[:2]):
                o = compare_runs(subject, other.as_run(), checkpoints_mod.section_bounds(cp_info))
                if o.stats.get("telemetry"):
                    pts[f"other{k}"] = o.points
            analyze_rows = checkpoints_mod.rows(cp_info, reference.get("checkpoints")) if cp_info else []
            lm = landmarks_mod.Landmarks(cp_info, result.corners, result.points, analyze_rows)
            blueprint_data = blueprint_mod.build(pts, "main", str(result.stats.get("reference_input_style", "analog")).startswith("analog"), lm)
            field_text = ""
            try:  # what the fastest ghosts do that the player doesn't: jump lines, air-brakes, different lines
                flights = {"main": signals_mod.public_flights(reference.get("samples") or [])}
                for k, other in enumerate(body.others[:2]):
                    if f"other{k}" in pts:
                        flights[f"other{k}"] = signals_mod.public_flights(other.as_run().get("samples") or [])
                moves = driving_mod.field_moves(pts, signals_mod.public_flights(subject.get("samples") or []), flights)
                if moves:
                    field_text = "WHAT THE FASTEST GHOSTS DO THAT THE PLAYER DOES NOT (each is a trick or a line to learn; say how to do it):\n" + "\n".join(f"- at ~{m['dist_m']:.0f} m: {m['text']}" for m in moves)
            except Exception:
                field_text = ""
        except Exception:
            blueprint_data = None
            field_text = ""

    insights = None
    if map_uid:
        try:
            insights = insights_mod.gather(
                map_uid, race_time_ms=subject.get("race_time_ms"), account_id=body.account_id,
            )
        except (ValueError, KeyError):
            insights = None

    # What each run did (jumps, airbrake, brake taps while steering, lifts) and
    # what kind of map this is, so the coach can name techniques, not just "go faster".
    signals_block, style_line, styles = "", "", []
    surface_block, inputs_block, figures_block = "", "", ""
    blueprint_block, steering_plan = "", False
    if result.stats.get("telemetry"):
        try:
            samples = subject.get("samples") or []
            labels = None
            share: dict[str, float] = {}
            if map_uid:
                try:
                    labels = surface_mod.surfaces_for_samples(map_uid, samples)
                except Exception:
                    labels = None
            dist = signals_mod._cumulative_distance(samples)
            corner_surf = surface_mod.corner_surfaces(labels, dist, result.corners) if labels else {}
            if labels:
                share = surface_mod.summarize(labels)
                surface_block = (
                    "SURFACE UNDER THE CAR over the whole lap (from the map's blocks, approximate): "
                    + ", ".join(f"{surface_mod.LABELS.get(k, k)} {v * 100:.0f}%" for k, v in list(share.items())[:5])
                    + ".\n" + coach.corner_context_text(result.corners, corner_surf)
                )
            else:
                surface_block = (
                    "SURFACE UNDER THE CAR: not available for this map, so don't assume one; say what you can't tell.\n"
                    + coach.corner_context_text(result.corners, None)
                )
            wanted = [it["index"] for it in found["focus"] if it.get("kind") == "corner"][:6] or [
                c["corner_index"] for c in sorted(result.corners, key=lambda c: -abs(c["time_change_ms"]))[:4]
            ]
            inputs_block = coach.input_scripts_text(result.corners, wanted)
            figures_block = coach.figures_text(result.corners)

            signals_block, features, tech_findings = signals_mod.signals_text(samples, reference.get("samples") or [])
            try:
                if cp_info:
                    signals_block += "\n" + checkpoints_mod.splits_text(checkpoints_mod.rows(cp_info, reference.get("checkpoints")))
            except Exception:
                pass
            bob_map = _is_bob(((insights or {}).get("map") or {}).get("tags") or [], share)
            try:
                s_drive = driving_mod.analyze(samples, bob_map)
                g_drive = driving_mod.analyze(reference.get("samples") or [], bob_map)
                extra = driving_mod.driving_text(s_drive, g_drive)
                if extra:
                    signals_block += "\n" + extra
                tech_findings = tech_findings + driving_mod.landing_findings(s_drive, g_drive)
            except Exception:
                pass
            try:
                found_skills = skills_mod.skills_text(skills_mod.compare(
                    skills_mod.detect(samples, labels, bob_map), skills_mod.detect(reference.get("samples") or [], _ground_labels(reference), bob_map), samples, dist))
                if found_skills:
                    signals_block += "\n" + found_skills
            except Exception:
                pass
            tech_findings = signals_mod.filter_by_surface(tech_findings, labels, dist)
            map_tags = ((insights or {}).get("map") or {}).get("tags") or []
            styles = techniques.detect_styles(map_tags, features, share)
            style_line = techniques.style_text(styles)
            signals_block += "\n" + signals_mod.findings_text(tech_findings, styles)
            # on ice and bobsleigh maps the whole lap is steering: give the coach every corner's script and the full blueprint
            icy = any(s in ("bobsleigh", "ice") for s, _ in styles)
            steering_plan = icy or body.depth in ("deep", "detailed")
            if icy:
                inputs_block = coach.input_scripts_text(result.corners, [c["corner_index"] for c in result.corners][:16])
            if blueprint_data:
                blueprint_block = blueprint_mod.blueprint_text(blueprint_data, deep=icy or body.depth == "deep")
                lessons_list = blueprint_mod.lessons(blueprint_data, icy)
                blueprint_block += "\n" + blueprint_mod.lessons_text(lessons_list)
                if field_text:
                    blueprint_block += "\n" + field_text
            try:
                cards = _make_playbook(
                    subject, reference, result.corners, result.points, lm, blueprint_data, [t for t in (((insights or {}).get("map") or {}).get("tags") or [])],
                    driving_mod.analyze(samples, bob_map), signals_mod.public_flights(samples), signals_mod.public_flights(reference.get("samples") or []))
                pb = playbook_mod.playbook_text(cards)
                how_to_cards = cards
                if pb:
                    blueprint_block += "\n" + pb
                    steering_plan = steering_plan or bool(cards)
            except Exception:
                pass
        except Exception:  # never let a signal bug block the analysis
            signals_block, style_line, styles = "", "", []
            surface_block, inputs_block, figures_block = "", "", ""
            blueprint_block, steering_plan = "", False

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
        signals=signals_block,
        style_line=style_line,
        surface_text=surface_block,
        inputs_text=inputs_block,
        figures=figures_block,
        blueprint=blueprint_block,
        plan=steering_plan,
    )

    # Count the analysis only when it uses the server's keys (a visitor's own
    # key is their own cost), and hand it back if the AI call fails.
    hits = [] if (not using_pool or _is_admin(x_admin_code)) else _consume_ai_quota(request)
    try:
        text = nim_client.analyze(
            coach_knowledge.system_prompt(styles), prompt, user_key=x_nim_key,
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
    if steering_plan:
        # the how-to lessons are written from the measured numbers, never by the model (it garbles them)
        text = playbook_mod.with_how_to(text, lessons_list, how_to_cards)
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


def _mx_http_error(e: "mx_client.MxError") -> HTTPException:
    return HTTPException(503 if e.unavailable else 502, str(e))


def _fallback_map_summary(map_uid: str, *, mx_unavailable: bool) -> dict | None:
    """Map details from trackmania.io, for when ManiaExchange is down or the
    map isn't on it (campaign maps)."""
    try:
        info = tmio_client.get_map_info(map_uid)
    except tmio_client.TmioError:
        return None
    if not info:
        return None
    author = (info.get("authorplayer") or {}).get("name")
    return {
        "map_id": info.get("exchangeid"),
        "map_uid": map_uid,
        "name": info.get("name"),
        "authors": [author] if author else [],
        "tags": [],
        "difficulty": None,
        "award_count": None,
        "replay_count": None,
        "thumbnail_url": info.get("thumbnailUrl") or "",
        "source": "trackmania.io",
        "mx_unavailable": mx_unavailable,
        "not_on_mx": not mx_unavailable,
        "medals": {
            "author": info.get("authorScore"),
            "gold": info.get("goldScore"),
            "silver": info.get("silverScore"),
            "bronze": info.get("bronzeScore"),
        },
    }


def _totd_maps(query: str | None, count: int, months: int = 3) -> list[dict]:
    """Recent Tracks of the Day (optionally filtered by name), shaped like the
    ManiaExchange summaries. This is the backup for map search when ManiaExchange
    is down: it comes from trackmania.io, which mirrors Nadeo's live data."""
    needle = (query or "").strip().lower()
    out: list[dict] = []
    for offset in range(months):
        try:
            days = tmio_client.get_totd_month(offset)
        except tmio_client.TmioError:
            continue
        for day in days:
            m = day.get("map") or {}
            uid = m.get("mapUid")
            name = coach._clean(m.get("name"))
            if not uid or (needle and needle not in name.lower()):
                continue
            author = (m.get("authorplayer") or {}).get("name")
            out.append({
                "map_id": m.get("exchangeid"),
                "map_uid": uid,
                "name": name,
                "authors": [author] if author else [],
                "tags": [],
                "difficulty": None,
                "award_count": None,
                "replay_count": None,
                "thumbnail_url": m.get("thumbnailUrl") or "",
                "source": "trackmania.io",
                "fallback": True,
                "totd": day.get("date") or "",
            })
            if len(out) >= count:
                return out
    return out


_today_cache: dict = {"at": 0.0, "value": None}


@app.get("/api/tmio/totd/today")
def tmio_totd_today():
    """Today's Track of the Day and its world record (cached for ten minutes)."""
    if _today_cache["value"] and time.time() - _today_cache["at"] < 600:
        return _today_cache["value"]
    maps = _totd_maps(None, 1, months=2)
    if not maps:
        raise HTTPException(502, "Today's Track of the Day isn't available from trackmania.io right now.")
    m = maps[0]
    wr = None
    try:
        entries = insights_mod.leaderboard_page(m["map_uid"], 0, 1)["entries"]
        if entries:
            wr = entries[0]
    except tmio_client.TmioError:
        pass
    value = {"day": m.get("totd"), "map": m, "wr": wr}
    _today_cache.update(at=time.time(), value=value)
    return value


class SharePayload(BaseModel):
    subject: RunPayload
    reference: RunPayload
    note: str | None = Field(default=None, max_length=140)


@app.get("/api/share/status")
def share_status():
    return {"available": shares.available()}


@app.post("/api/share")
def create_share(body: SharePayload, request: Request):
    """Keep a comparison for 30 days under a short link. Only runs the visitor chose to share are stored."""
    hit = ratelimit.get_limiter().check("share", _visitor(request), 12, 3600)
    if not hit.allowed:
        raise HTTPException(429, "You've made a lot of share links this hour. Try again later.", headers={"Retry-After": str(hit.retry_after)})
    try:
        share_id = shares.create(body.subject.as_run(), body.reference.as_run(), body.note)
    except shares.ShareError as e:
        hit.refund()
        raise HTTPException(e.status, str(e)) from e
    return {"id": share_id, "days": shares.TTL_S // 86400}


@app.get("/api/share/{share_id}")
def get_share(share_id: str):
    try:
        return shares.fetch(share_id)
    except shares.ShareError as e:
        raise HTTPException(e.status, str(e)) from e


@app.get("/api/mx/search")
def mx_search(name: str | None = None, tag: str | None = None, count: int = 24):
    try:
        return [_mx_map_summary(m) for m in mx_client.search_maps(name=name, tag=tag, count=count)]
    except mx_client.MxError as e:
        if e.unavailable:
            backup = _totd_maps(name, max(1, min(count, 50)))
            if backup:
                return backup  # ManiaExchange is down: recent Tracks of the Day instead
            if name and name.strip():
                raise HTTPException(
                    503,
                    f"ManiaExchange isn't responding right now, and no recent Track of the Day matches “{name.strip()}”. "
                    "Try again in a minute, or search for a name from a recent Track of the Day.",
                ) from e
        raise _mx_http_error(e) from e


@app.get("/api/tmio/totd")
def tmio_totd(name: str | None = None, count: int = 24, months: int = 3):
    """Recent Tracks of the Day, newest first, optionally filtered by name."""
    try:
        return _totd_maps(name, max(1, min(count, 100)), max(1, min(months, 12)))
    except tmio_client.TmioError as e:
        raise HTTPException(502, str(e)) from e


_map_info_cache: dict[str, dict | None] = {}


@app.get("/api/mx/map-info/{map_uid}")
def mx_map_info(map_uid: str):
    """Name, thumbnail, authors and tags only (no replay list) — cheap enough to
    ask for every map on the front page."""
    try:
        net.valid_map_uid(map_uid)
    except ValueError:
        raise HTTPException(400, "invalid map uid") from None
    if map_uid not in _map_info_cache:
        try:
            m = mx_client.get_map_by_uid(map_uid)
        except mx_client.MxError as e:
            fallback = _fallback_map_summary(map_uid, mx_unavailable=e.unavailable) if e.unavailable else None
            if fallback:
                return fallback  # not remembered: ManiaExchange may be back in a minute
            raise _mx_http_error(e) from e
        _map_info_cache[map_uid] = _mx_map_summary(m) if m else None
        if len(_map_info_cache) > 2000:
            _map_info_cache.pop(next(iter(_map_info_cache)))
    info = _map_info_cache[map_uid]
    if info is None:
        fallback = _fallback_map_summary(map_uid, mx_unavailable=False)
        if fallback:
            return fallback
        raise HTTPException(404, "map not found on ManiaExchange")
    return info


@app.get("/api/mx/maps/{map_uid}")
def mx_map_detail(map_uid: str):
    try:
        m = mx_client.get_map_by_uid(map_uid)
    except mx_client.MxError as e:
        fallback = _fallback_map_summary(map_uid, mx_unavailable=True) if e.unavailable else None
        if fallback:
            return {**fallback, "replays": []}
        raise _mx_http_error(e) from e
    if not m:
        fallback = _fallback_map_summary(map_uid, mx_unavailable=False)
        if fallback:
            return {**fallback, "replays": []}
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
def tmio_leaderboard(map_uid: str, length: int = 20, offset: int = 0):
    """One page of the world leaderboard: {total, offset, entries}."""
    try:
        net.valid_map_uid(map_uid)
    except ValueError:
        raise HTTPException(400, "invalid map uid") from None
    length = max(1, min(length, 100))
    offset = max(0, min(offset, 1_000_000))
    try:
        return insights_mod.leaderboard_page(map_uid, offset, length)
    except tmio_client.TmioError as e:
        raise HTTPException(502, str(e)) from e


@app.get("/api/tmio/maps/{map_uid}/locate")
def tmio_locate(map_uid: str, time_ms: int):
    """Which leaderboard page holds this finish time (binary search by time)."""
    try:
        net.valid_map_uid(map_uid)
    except ValueError:
        raise HTTPException(400, "invalid map uid") from None
    if not 0 < time_ms < 100_000_000:
        raise HTTPException(400, "time_ms out of range")
    try:
        return tmio_client.locate_time(map_uid, time_ms)
    except tmio_client.TmioError as e:
        raise HTTPException(502, str(e)) from e


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
