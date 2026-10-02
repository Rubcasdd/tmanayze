"""Self-contained parser for Trackmania 2020 .Gbx replay/ghost files.

Extracts map/player metadata from the file header and the ~50ms-interval
vehicle telemetry stream (position, speed, steering, gas, brake) from the
body. Works purely on in-memory bytes (no temp files), so it runs unchanged
on read-only serverless platforms.

Format notes (Nadeo's GBX container, as documented by the community, notably
BigBang1112/gbx-net — no source from that project is copied here):

* Header: "GBX" magic, version (6), format/compression flag bytes, the root
  class id, then "user data" header chunks. Chunk 0x03093000 holds the map
  ident, race time and player nickname (strings are "lookback ids": a string
  table where each string is spelled out once and referenced by index after).
  Chunk 0x03093001 is an XML blob with the map name.
* Body: LZO1X-compressed (see lzo1x.py). Inside it, the
  CPlugEntRecordData node (chunk 0x0911F000) carries a zlib-compressed
  record: a list of "entities", one of which is the vehicle. Its samples are
  fixed-size byte buffers whose fields (steer, brake, position, speed...)
  live at fixed offsets.
* Record version < 11 stores samples one by one (flag byte, time, length-
  prefixed blob). Version >= 11 (current game clients, e.g. leaderboard
  ghosts) stores them columnar and delta-encoded: sample count, per-sample
  delta times, then for each byte offset one byte per sample, each added to
  the previous sample's byte (mod 256). The sample buffer is also longer
  (116 vs 107 bytes) but every field we read sits in the leading 107 bytes.
"""

from __future__ import annotations

import html
import math
import re
import struct
import zlib
from dataclasses import dataclass, field

from . import lzo1x

_RECORD_DATA_CHUNK_ID = b"\x00\xf0\x11\x09"  # 0x0911F000, little-endian
_VEHICLE_SAMPLE_MIN_SIZE = 107
_MAX_TABLE_ENTRIES = 10_000
_MAX_CHUNK_BYTES = 100_000_000
_MS_TO_KMH = 3.6


class GbxParseError(ValueError):
    """Raised when the bytes are not a Trackmania Gbx file we can read."""


@dataclass
class ParsedRun:
    map_uid: str | None
    map_name: str | None
    player_nickname: str | None
    race_time_ms: int | None
    num_checkpoints: int | None
    samples: list[dict] = field(default_factory=list)
    telemetry_available: bool = False


class _Reader:
    """Minimal little-endian cursor over a bytes object."""

    def __init__(self, data: bytes, pos: int = 0):
        self.data = data
        self.pos = pos

    def _unpack(self, fmt: str, size: int):
        end = self.pos + size
        if end > len(self.data):
            raise EOFError("unexpected end of data")
        value = struct.unpack_from(fmt, self.data, self.pos)[0]
        self.pos = end
        return value

    def u8(self) -> int:
        return self._unpack("<B", 1)

    def u16(self) -> int:
        return self._unpack("<H", 2)

    def i32(self) -> int:
        return self._unpack("<i", 4)

    def u32(self) -> int:
        return self._unpack("<I", 4)

    def take(self, n: int) -> bytes:
        if n < 0 or self.pos + n > len(self.data):
            raise EOFError("unexpected end of data")
        chunk = self.data[self.pos:self.pos + n]
        self.pos += n
        return chunk

    def string(self) -> str:
        length = self.u32()
        if length == 0:
            return ""
        if length > 100_000:
            raise ValueError("implausible string length")
        raw = self.take(length)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.decode("latin-1", errors="ignore")


class _LookbackStrings:
    """GBX's string interning: a version number precedes the first id, then
    each id is a u32 whose top two bits say what it is. Low bits 0 mean "a
    new string follows inline" (remembered under the next slot number),
    otherwise they are a 1-based reference to an earlier string. Ids without
    the 01/10 flag are numeric collection ids, and 0xFFFFFFFF is null."""

    def __init__(self):
        self._version: int | None = None
        self._strings: dict[int, str] = {}

    def read_id(self, r: _Reader) -> str:
        if self._version is None:
            self._version = r.u32()
            if self._version < 3:
                raise ValueError("unsupported id table version")
        index = r.u32()
        if index == 0xFFFFFFFF:
            return ""
        if ((index >> 30) & 0x3) not in (1, 2):
            return ""
        slot = index & 0x3FFFFFFF
        if slot != 0:
            return self._strings.get(slot, "")
        text = r.string()
        self._strings[len(self._strings) + 1] = text
        return text

    def read_ident(self, r: _Reader) -> tuple[str, str, str]:
        return self.read_id(r), self.read_id(r), self.read_id(r)


def parse_gbx_bytes(data: bytes) -> ParsedRun:
    r = _Reader(data)
    if r.take(3) != b"GBX":
        raise GbxParseError("not a Gbx file (missing GBX magic)")
    try:
        version = r.u16()
        if version != 6:
            raise GbxParseError(f"unsupported Gbx version {version} (expected 6)")
        r.u8()  # format ('B'inary)
        r.u8()  # reference-table compression
        body_compression = r.u8()
        r.u8()  # unknown ('R')
        r.u32()  # root class id
        metadata = _read_user_data(r)
        r.u32()  # node count
        num_external = r.u32()
    except (EOFError, ValueError, struct.error) as e:
        raise GbxParseError(f"could not read Gbx header: {e}") from e

    samples: list[dict] = []
    if num_external == 0:
        body = _read_body(r, body_compression)
        if body:
            samples = _extract_vehicle_samples(body)

    return ParsedRun(
        map_uid=metadata.get("map_uid"),
        map_name=metadata.get("map_name"),
        player_nickname=metadata.get("player_nickname"),
        race_time_ms=metadata.get("race_time_ms"),
        num_checkpoints=metadata.get("num_checkpoints"),
        samples=samples,
        telemetry_available=bool(samples),
    )


def _read_user_data(r: _Reader) -> dict:
    user_data_size = r.u32()
    meta: dict = {}
    if user_data_size == 0:
        return meta

    start = r.pos
    chunk_count = r.u32()
    chunks = []
    for _ in range(chunk_count):
        chunk_id = r.u32()
        size = r.u32() & 0x7FFFFFFF  # top bit is the "heavy" flag
        chunks.append((chunk_id, size))

    ids = _LookbackStrings()
    for chunk_id, size in chunks:
        chunk_start = r.pos
        try:
            if chunk_id == 0x03093000:
                _read_replay_header_chunk(r, ids, meta)
            elif chunk_id == 0x03093001:
                _read_replay_xml_chunk(r, meta)
        except (EOFError, ValueError, struct.error):
            pass  # a malformed optional chunk shouldn't sink the whole file
        r.pos = chunk_start + size
    r.pos = start + user_data_size
    return meta


def _read_replay_header_chunk(r: _Reader, ids: _LookbackStrings, meta: dict) -> None:
    chunk_version = r.u32()
    if chunk_version >= 4 and chunk_version != 9999:
        map_uid, _collection, _author = ids.read_ident(r)
        if map_uid:
            meta["map_uid"] = map_uid
    race_time = r.i32()
    if race_time >= 0:
        meta["race_time_ms"] = race_time
    nickname = r.string()
    if nickname:
        meta["player_nickname"] = nickname


def _read_replay_xml_chunk(r: _Reader, meta: dict) -> None:
    xml = r.string()
    if not xml:
        return
    if m := re.search(r'<map[^>]+name="([^"]+)"', xml):
        meta["map_name"] = html.unescape(m.group(1))
    if "race_time_ms" not in meta and (m := re.search(r'times best="(\d+)"', xml)):
        meta["race_time_ms"] = int(m.group(1))
    if m := re.search(r'checkpoints cur="(\d+)"', xml):
        meta["num_checkpoints"] = int(m.group(1))


def _read_body(r: _Reader, compression: int) -> bytes | None:
    try:
        if compression != 0x43:  # 'C' = compressed, 'U' = stored as-is
            return r.data[r.pos:]
        uncompressed_size = r.u32()
        compressed_size = r.u32()
        compressed = r.take(compressed_size)
    except (EOFError, struct.error):
        return None
    try:
        return zlib.decompress(compressed)
    except zlib.error:
        pass
    try:
        payload, _consumed = lzo1x.decompress(compressed, uncompressed_size)
        return payload
    except (lzo1x.LzoError, IndexError):
        return None


def _extract_vehicle_samples(body: bytes) -> list[dict]:
    # The marker also occurs as an unrelated false positive earlier in real
    # files, so try every occurrence until one decodes into a record.
    for match in re.finditer(re.escape(_RECORD_DATA_CHUNK_ID), body):
        decoded = _decode_record_chunk(body, match.end())
        if decoded is None:
            continue
        record, version = decoded
        raw = _find_vehicle_buffers(record, version)
        if not raw:
            continue
        samples = [_decode_sample(t, buf) for t, buf in raw]
        samples = [s for s in samples if s is not None]
        if samples:
            return samples
    return []


def _decode_record_chunk(body: bytes, offset: int) -> tuple[bytes, int] | None:
    try:
        r = _Reader(body, offset)
        version = r.u32()
        if not 5 <= version <= 15:
            return None
        uncompressed_size = r.u32()
        data_length = r.u32()
        if uncompressed_size > _MAX_CHUNK_BYTES or not 10 <= data_length <= _MAX_CHUNK_BYTES:
            return None
        return zlib.decompress(r.take(data_length)), version
    except (zlib.error, EOFError, struct.error):
        return None


def _read_encoded_deltas(r: _Reader) -> list[tuple[int, bytes]] | None:
    """Version >= 11 sample encoding (see module docstring)."""
    count = r.i32()
    if count == 0:
        return []
    if not 0 < count <= 100_000:
        return None
    size = r.i32()
    if not 0 < size <= 10_000:
        return None

    times: list[int] = []
    t = 0
    for _ in range(count):
        t += r.i32()
        times.append(t)

    buffers = [bytearray(size) for _ in range(count)]
    for col in range(size):
        column = r.take(count)
        acc = 0
        for i in range(count):
            acc = (acc + column[i]) & 0xFF
            buffers[i][col] = acc
    return [(times[i], bytes(buffers[i])) for i in range(count)]


def _find_vehicle_buffers(record: bytes, version: int) -> list[tuple[int, bytes]]:
    """Walk the record's entity list and return the (time_ms, buffer) samples
    of the vehicle — the entity whose sample buffers are at least 107 bytes."""
    best: list[tuple[int, bytes]] = []
    try:
        r = _Reader(record)
        r.i32()  # start time
        r.i32()  # end time

        desc_count = r.u32()
        if desc_count > _MAX_TABLE_ENTRIES:
            return []
        for _ in range(desc_count):
            r.u32()  # class id
            r.i32()
            r.i32()
            r.i32()
            r.take(r.u32())
            r.i32()

        notice_count = r.u32()
        if notice_count > _MAX_TABLE_ENTRIES:
            return []
        for _ in range(notice_count):
            r.i32()
            r.i32()
            r.u32()

        while r.u8() == 1:
            for _ in range(5):  # entity type/index + four unknowns
                r.i32()

            if version >= 11:
                samples = _read_encoded_deltas(r)
                if samples is None:
                    return best
            else:
                samples = []
                while r.u8() == 1:
                    time_ms = r.i32()
                    samples.append((time_ms, r.take(r.u32())))

            r.u8()  # "has next" flag
            while r.u8() == 1:  # secondary sample list, not needed
                r.i32()
                r.i32()
                r.take(r.u32())

            if samples and len(samples[0][1]) >= _VEHICLE_SAMPLE_MIN_SIZE:
                best = samples
        return best
    except (EOFError, ValueError, struct.error):
        return best


_POSITION = struct.Struct("<3f")
_SPEED_RAW = struct.Struct("<h")


def _decode_sample(time_ms: int, buf: bytes) -> dict | None:
    """Pick the fields we use out of one vehicle sample buffer. Offsets are
    fixed by the game (steer at 14, gas component at 15, brake at 18,
    position as three floats at 47, compressed speed at 65)."""
    if len(buf) < _VEHICLE_SAMPLE_MIN_SIZE:
        return None
    x, y, z = _POSITION.unpack_from(buf, 47)
    speed_raw = _SPEED_RAW.unpack_from(buf, 65)[0]
    steer = (buf[14] / 255.0 - 0.5) * 2.0
    brake = buf[18] / 255.0
    gas = min(1.0, buf[15] / 255.0 + brake)
    return {
        "time_ms": time_ms,
        "x": round(x, 2),
        "y": round(y, 2),
        "z": round(z, 2),
        "speed": round(math.exp(speed_raw / 1000.0) * _MS_TO_KMH, 1),
        "steer": round(steer, 3),
        "gas": round(gas, 2),
        "brake": round(brake, 2),
    }
