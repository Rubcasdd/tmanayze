"""Reads the block list out of a Trackmania 2020 .Map.Gbx.

A map file is a Gbx container (see gbx_parser.py): a header, then an
LZO-compressed body made of chunks. The chunk we want holds every block placed
on the 48x48 grid: its name (such as "RoadIce"), where it sits (grid cell and
height) and which way it faces. From the block names we can tell what surface
the car is driving on, which the replays themselves don't say.

Only the chunks that come before the block list are read, and only far enough
to keep the string table in step (block names are stored as "look-back
strings": the first use of a name spells it out, later uses are an index).
Everything that can be skipped is skipped by its size marker.

Anything unexpected makes the reader stop and return what it has, flagged as
partial, rather than guess.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

from . import lzo1x

SKIP_MARK = 0x534B4950  # "SKIP": a chunk that can be skipped has this and its size after the id
NODE_END = 0xFACADE01   # ends a nested object


class MapParseError(ValueError):
    pass


@dataclass
class Block:
    name: str
    x: int
    y: int
    z: int
    direction: int
    flags: int


@dataclass
class MapBlocks:
    size: tuple[int, int, int] = (48, 40, 48)
    blocks: list[Block] = field(default_factory=list)
    partial: bool = False
    note: str = ""


class _R:
    def __init__(self, data: bytes, pos: int = 0):
        self.d = data
        self.p = pos
        self.strings: list[str] = []
        self.lookback_started = False

    def need(self, n: int) -> None:
        if self.p + n > len(self.d):
            raise MapParseError("ran past the end of the map")

    def u8(self) -> int:
        self.need(1); v = self.d[self.p]; self.p += 1; return v

    def u32(self) -> int:
        self.need(4); v = struct.unpack_from("<I", self.d, self.p)[0]; self.p += 4; return v

    def i32(self) -> int:
        self.need(4); v = struct.unpack_from("<i", self.d, self.p)[0]; self.p += 4; return v

    def skip(self, n: int) -> None:
        self.need(n); self.p += n

    def string(self) -> str:
        n = self.u32()
        if n > 1_000_000:
            raise MapParseError("implausible string length")
        self.need(n)
        s = self.d[self.p:self.p + n].decode("utf-8", errors="replace")
        self.p += n
        return s

    def lookback(self) -> str:
        """A string stored once and then referred to by number."""
        if not self.lookback_started:
            self.u32()  # version marker that precedes the first one
            self.lookback_started = True
        index = self.u32()
        if index == 0xFFFFFFFF:
            return ""
        if (index & 0xC0000000) == 0:
            # a collection id or other well-known number, not text
            return f"#{index}"
        if (index & 0x3FFFFFFF) == 0:
            s = self.string()
            self.strings.append(s)
            return s
        n = (index & 0x3FFFFFFF) - 1
        if n >= len(self.strings):
            raise MapParseError("look-back string refers to one we never read")
        return self.strings[n]


def _read_header(data: bytes) -> tuple[bytes, int]:
    if data[:3] != b"GBX":
        raise MapParseError("not a Gbx file")
    version = struct.unpack_from("<H", data, 3)[0]
    if version != 6:
        raise MapParseError(f"unsupported Gbx version {version}")
    body_compressed = data[7:8] == b"C"
    p = 13
    user_data = struct.unpack_from("<I", data, p)[0]
    p += 4 + user_data
    p += 4  # node count
    external = struct.unpack_from("<I", data, p)[0]
    p += 4
    if external:
        raise MapParseError("maps with external references aren't supported")
    if not body_compressed:
        return data[p:], 0
    uncompressed, compressed = struct.unpack_from("<II", data, p)
    p += 8
    body, _ = lzo1x.decompress(data[p:p + compressed], uncompressed)
    return body, 0


def _skip_node(r: _R) -> None:
    """Get past a nested object (after its class id). The objects that hang off blocks
    (skins, checkpoint properties) hold no further objects, so the end marker that
    closes them is the first one ahead; this avoids having to know every chunk layout."""
    end = r.d.find(struct.pack("<I", NODE_END), r.p)
    if end < 0:
        raise MapParseError("a nested object never ended")
    r.p = end + 4


def _node_ref(r: _R, seen: set[int]) -> None:
    """A reference to an object: -1 for none, a number seen before for a repeat,
    otherwise a new number followed by the object's class id and contents."""
    idx = r.i32()
    if idx < 0 or idx in seen:
        return
    seen.add(idx)
    r.u32()  # class id
    _skip_node(r)


def _read_collector_list(r: _R) -> None:
    """The list of embedded item/block collections (chunk 0301B000), which defines
    look-back strings that later parts of the map refer to."""
    while True:
        cid = r.u32()
        if cid == NODE_END:
            return
        marker = r.u32()
        skippable = marker == SKIP_MARK
        size = r.u32() if skippable else 0
        if not skippable:
            r.p -= 4
        start = r.p
        if cid == 0x0301B000:
            for _ in range(r.u32()):
                r.lookback(); r.lookback(); r.lookback()
                r.u32()
            if skippable:
                r.p = start + size
        elif skippable:
            r.skip(size)
        else:
            raise MapParseError(f"unexpected chunk {cid:08X} in the collector list")


def _read_params(r: _R) -> None:
    """The challenge parameters object (medals and so on): none of it matters here."""
    fixed = {0x0305B000: 32, 0x0305B005: 12, 0x0305B008: 8, 0x0305B00A: 36, 0x0305B00D: 4, 0x0305B004: 20}
    while True:
        cid = r.u32()
        if cid == NODE_END:
            return
        marker = r.u32()
        if marker == SKIP_MARK:
            r.skip(r.u32())
            continue
        r.p -= 4
        if cid in fixed:
            r.skip(fixed[cid])
        elif cid == 0x0305B001:
            for _ in range(4):
                r.string()
        elif cid == 0x0305B006:
            r.skip(r.u32() * 4)
        else:
            raise MapParseError(f"unexpected chunk {cid:08X} in the parameters")


def _read_nested(r: _R, class_id: int) -> None:
    if class_id == 0x0301B000:
        _read_collector_list(r)
    elif class_id == 0x0305B000:
        _read_params(r)
    else:
        _skip_node(r)


def _read_blocks(r: _R, out: MapBlocks) -> None:
    """Chunk 0304301F: map identity, size and the block list."""
    r.lookback(); r.lookback(); r.lookback()      # map uid, collection, author
    r.string()                                     # map name
    r.lookback(); r.lookback(); r.lookback()      # mood, background, background author
    out.size = (r.i32(), r.i32(), r.i32())
    r.i32()                                        # required unlock
    map_flags = r.i32()
    count = r.u32()
    if count > 200_000:
        raise MapParseError("implausible block count")
    seen: set[int] = set()
    for _ in range(count):
        name = r.lookback()
        direction = r.u8()
        x, y, z = r.u8(), r.u8(), r.u8()
        flags = r.u32() if map_flags > 0 else struct.unpack("<H", bytes([r.u8(), r.u8()]))[0]
        if flags == 0xFFFFFFFF:
            continue                               # a removed or free block: no cell to record
        if name != "Unassigned1":
            out.blocks.append(Block(name, x, y, z, direction, flags))
        if flags & 0x8000:
            r.lookback()                           # skin author
            _node_ref(r, seen)                     # the skin
        if flags & 0x100000:
            _node_ref(r, seen)                     # checkpoint / start / finish properties


def parse_map_blocks(data: bytes) -> MapBlocks:
    """The blocks of a map. Raises MapParseError only when the file isn't a
    readable map at all; a map that goes wrong half-way comes back `partial`."""
    out = MapBlocks()
    try:
        body, _ = _read_header(data)
    except (struct.error, lzo1x.LzoError, IndexError) as e:
        raise MapParseError(f"couldn't read the map: {e}") from e

    r = _R(body)
    try:
        while True:
            cid = r.u32()
            if cid == NODE_END:
                out.partial = True
                out.note = "reached the end of the map without finding the block list"
                return out
            marker = r.u32()
            skippable = marker == SKIP_MARK
            size = r.u32() if skippable else 0
            if not skippable:
                r.p -= 4
            start = r.p
            if cid in (0x0304301F, 0x2400301F):
                _read_blocks(r, out)
                return out
            if cid in (0x0304300D, 0x2400300D):
                r.lookback(); r.lookback(); r.lookback()
            elif cid in (0x03043011, 0x24003011):
                for _ in range(2):
                    idx = r.i32()
                    if idx >= 0:
                        _read_nested(r, r.u32())
                r.u32()
            elif skippable:
                r.skip(size)
                continue
            else:
                raise MapParseError(f"unexpected non-skippable chunk {cid:08X}")
            if skippable:
                r.p = start + size
    except (MapParseError, struct.error) as e:
        out.partial = True
        out.note = str(e)
        return out
