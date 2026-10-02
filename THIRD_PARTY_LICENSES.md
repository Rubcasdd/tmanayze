# Third-party notices

## backend/lzo1x.py — vendored, MIT

Vendored from `AndreaGordanelli/qnxsec` (`qnxsec/lzo.py`), MIT License:

```
MIT License

Copyright (c) 2026 Andrea Gordanelli

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## backend/gbx_parser.py — original implementation, format knowledge only

The Gbx container and replay-record layouts it reads (header chunk layout,
string table, record versions including the version 11 columnar delta
encoding, and the byte offsets of the vehicle sample fields) were learned from
the community's documentation of Nadeo's format, in particular by reading
`BigBang1112/gbx-net` (C#) and `villezekeviking/tm2020-gbx-parser` (Python).
Neither project publishes a license file, so no source from either is copied or
vendored and neither is a dependency; this is an independent implementation,
validated by comparing its output with theirs on real replay files. The binary
format itself belongs to Nadeo, not to either project.

## Data sources

Map data and community replays come from ManiaExchange (trackmania.exchange);
leaderboards and player profiles from the community-run trackmania.io API.
Both are used within their stated terms (descriptive User-Agent, rate limiting).
