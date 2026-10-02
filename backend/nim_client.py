"""Client for the NVIDIA NIM chat/completions API.

Answers are streamed from NVIDIA and assembled server-side. Streaming keeps the
connection alive while a reasoning model thinks, and lets us enforce one total
deadline (so a long answer can never run into the platform's function
timeout — we return what we have instead).

Keys come from the server's pool (see keypool.py): one key per request in
rotation, with automatic failover to the next key if NVIDIA throttles or
rejects one. A visitor can instead supply their own key, which is used alone.

Two different kinds of "busy" are handled differently:

* HTTP 429 means *that key* is being rate limited, so the key is put on a
  cooldown and the next key is tried.
* NVIDIA's free tier also runs out of *worker capacity* for everyone at once.
  When streaming it reports this as HTTP 200 with an error event inside the
  stream ("ResourceExhausted ... limit reached"), or as HTTP 503. That isn't
  the key's fault, so we back off briefly and retry (rotating keys) instead of
  benching a good key.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass

import requests

from . import keypool

NIM_URL = os.environ.get("NIM_URL") or "https://integrate.api.nvidia.com/v1/chat/completions"
DEFAULT_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"

# Total wall-clock budget for one analysis, kept under the 300 s function limit.
DEADLINE_S = float(os.environ.get("NIM_DEADLINE_S") or 270)
KEY_RATE_LIMIT_COOLDOWN_S = 45
KEY_REJECTED_COOLDOWN_S = 3600
CAPACITY_BACKOFF_S = 3
MIN_TIME_FOR_ATTEMPT_S = 25


class NimConfigError(RuntimeError):
    """No key is available at all."""


class NimRequestError(RuntimeError):
    pass


class NimBusyError(NimRequestError):
    """NVIDIA is out of capacity or every key is throttled."""

    def __init__(self, message: str, retry_after: int = 30):
        super().__init__(message)
        self.retry_after = retry_after


class _KeyRejected(Exception):
    pass


class _KeyRateLimited(Exception):
    pass


class _OutOfCapacity(Exception):
    pass


@dataclass
class AnalysisParams:
    max_tokens: int = 9000
    reasoning_budget: int = 1500
    temperature: float = 0.4


def _classify_error(obj: dict) -> Exception | None:
    """Turn an error object (from an HTTP body or an in-stream event) into one
    of our exceptions."""
    err = obj.get("error") if isinstance(obj, dict) else None
    if not err:
        return None
    message = str(err.get("message", "")) if isinstance(err, dict) else str(err)
    code = err.get("code") if isinstance(err, dict) else None
    lowered = message.lower()
    if code in (401, 403) or "unauthorized" in lowered or "invalid api key" in lowered:
        return _KeyRejected()
    if code == 429 or "rate limit" in lowered or "too many requests" in lowered:
        return _KeyRateLimited()
    if "resourceexhausted" in lowered or "limit reached" in lowered or code == 503 or "overloaded" in lowered:
        return _OutOfCapacity()
    return NimRequestError(f"NVIDIA NIM error: {message[:300]}")


def _stream_once(key: str, system: str, prompt: str, params: AnalysisParams, deadline: float, model: str | None) -> tuple[str, str | None]:
    payload = {
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "model": model or os.environ.get("NIM_MODEL") or DEFAULT_MODEL,
        "max_tokens": params.max_tokens,
        "reasoning_budget": params.reasoning_budget,
        "temperature": params.temperature,
        "top_p": 0.9,
        "stream": True,
        "chat_template_kwargs": {"enable_thinking": True},
    }
    headers = {"Authorization": f"Bearer {key}", "Accept": "text/event-stream"}
    try:
        resp = requests.post(NIM_URL, headers=headers, json=payload, stream=True, timeout=(10, 90))
    except requests.RequestException as e:
        raise NimRequestError(f"could not reach NVIDIA NIM: {e}") from e

    with resp:
        if resp.status_code in (401, 403):
            raise _KeyRejected()
        if resp.status_code == 429:
            raise _KeyRateLimited()
        if resp.status_code in (500, 502, 503, 504):
            raise _OutOfCapacity()
        if not resp.ok:
            raise NimRequestError(f"NVIDIA NIM returned {resp.status_code}: {resp.text[:300]}")

        parts: list[str] = []
        cut: str | None = None  # why the answer ended early: 'time' or 'length'
        try:
            for line in resp.iter_lines(decode_unicode=True):
                if time.monotonic() > deadline:
                    cut = "time"
                    break
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    event = json.loads(data)
                except ValueError:
                    continue
                problem = _classify_error(event)
                if problem is not None:
                    if parts:  # keep what already arrived
                        cut = "time"
                        break
                    raise problem
                try:
                    choice = event["choices"][0]
                    delta = choice.get("delta") or {}
                except (KeyError, IndexError, AttributeError):
                    continue
                if delta.get("content"):
                    parts.append(delta["content"])
                if choice.get("finish_reason") == "length":
                    cut = "length"
        except requests.RequestException as e:
            if not parts:
                raise NimRequestError(f"connection to NVIDIA NIM dropped: {e}") from e
            cut = "time"
    return "".join(parts), cut


def analyze(
    system: str,
    prompt: str,
    *,
    user_key: str | None = None,
    params: AnalysisParams | None = None,
    model: str | None = None,
) -> str:
    params = params or AnalysisParams()
    deadline = time.monotonic() + DEADLINE_S

    pool = None
    own_key = (user_key or "").strip()
    if own_key:
        n_keys = 1
    else:
        pool = keypool.get_pool()
        n_keys = len(pool)
        if n_keys == 0:
            raise NimConfigError(
                "No NVIDIA NIM API key is available. The site owner needs to set NVIDIA_NIM_API_KEYS "
                "(or NVIDIA_NIM_API_KEY), or you can paste your own key into Settings."
            )

    max_attempts = max(6, n_keys * 2)
    rejected = 0
    for attempt in range(max_attempts):
        if deadline - time.monotonic() < MIN_TIME_FOR_ATTEMPT_S:
            break
        if pool is not None:
            key = pool.order()[0]  # next in rotation, healthy keys first
            if pool.all_cooling() > 0:
                break  # every key is benched; nothing to try right now
        else:
            key = own_key

        try:
            text, cut = _stream_once(key, system, prompt, params, deadline, model)
        except _KeyRejected:
            rejected += 1
            if pool is None:
                raise NimRequestError("NVIDIA NIM rejected your API key — check that you pasted it correctly.") from None
            pool.penalize(key, KEY_REJECTED_COOLDOWN_S)
            continue
        except _KeyRateLimited:
            if pool is None:
                raise NimBusyError("NVIDIA is rate limiting your key — try again shortly.") from None
            pool.penalize(key, KEY_RATE_LIMIT_COOLDOWN_S)
            continue
        except _OutOfCapacity:
            # Not the key's fault: NVIDIA's shared workers are full. Back off
            # briefly, then try again (with the next key if there is one).
            if pool is not None:
                pool.penalize(key, 1)
            wait = min(CAPACITY_BACKOFF_S * (attempt + 1), 8)
            if deadline - time.monotonic() > wait + MIN_TIME_FOR_ATTEMPT_S:
                time.sleep(wait)
            continue

        if not text.strip():
            raise NimRequestError(
                "NVIDIA NIM ran out of tokens while thinking and returned no answer — "
                "try again, or choose a more concise detail level."
            )
        if cut == "time":
            text += "\n\n*(The answer was cut short to stay within the time limit.)*"
        elif cut == "length":
            text += "\n\n*(The AI ran out of space before finishing — try again, or choose the Concise detail level.)*"
        return text

    if pool is not None and rejected and rejected >= n_keys:
        raise NimRequestError("The server's AI keys were all rejected by NVIDIA — the site owner needs to update them.")
    retry = int(pool.all_cooling()) + 1 if pool is not None else 20
    raise NimBusyError(
        "The AI is at capacity right now (the free NVIDIA tier is shared by many users). "
        "Please try again in a moment.",
        retry_after=max(10, retry),
    )
