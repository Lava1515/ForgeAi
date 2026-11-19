"""Fetch CC0 assets from Poly Haven into the local asset library (host tool, standard library only).

The library is read by `blender_worker/codebuilt/library.py` inside the job fence, which has no network. So assets are
fetched here, on the host, before a job runs. Only Poly Haven is supported: every asset there is CC0 1.0
(https://polyhaven.com/license), and its API is free for commercial use (https://polyhaven.com/our-api) as long as each
request carries a User-Agent that names the application.

  python tools/asset_library.py search hdris sunset clear
  python tools/asset_library.py search models chair
  python tools/asset_library.py fetch hdris kloofendal_48d_partly_cloudy_puresky
  python tools/asset_library.py fetch models Drill_01
  python tools/asset_library.py starter            # the curated starter set (about 0.6 GB)
  python tools/asset_library.py list

Files land in `blender_worker/codebuilt/assets/polyhaven/` (git-ignored); `assets/catalog.json` lists what is local.
Author: claude-pro · claude-fable-5-2, 2026-11-19.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

API = "https://api.polyhaven.com"
DOWNLOAD_PREFIX = "https://dl.polyhaven.org/"
USER_AGENT = "CodebuiltAssetLibrary/1.0"
DEFAULT_ROOT = Path(__file__).resolve().parents[1] / "blender_worker" / "codebuilt" / "assets"
KINDS = ("hdris", "models")
HDRI_RES, MODEL_RES = "2k", "1k"
MAX_FILE_BYTES = 200 * 1024 * 1024
MAX_POLYCOUNT = 400_000
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
SAFE_REL = re.compile(r"^[A-Za-z0-9_./-]{1,200}$")

# Starter set: how many of the most downloaded assets to take per bucket. A bucket is (kind, words that must all be
# found in the asset's category, attributes and tags). The first bucket an asset matches claims it.
STARTER = [
    ("hdris", ("studio",), 4), ("hdris", ("indoor",), 4), ("hdris", ("pure skies", "clear"), 3),
    ("hdris", ("pure skies", "partly cloudy"), 2), ("hdris", ("pure skies", "sunrise-sunset"), 3),
    ("hdris", ("pure skies", "overcast"), 2), ("hdris", ("night",), 4), ("hdris", ("urban", "outdoor"), 3),
    ("hdris", ("nature", "midday"), 3), ("hdris", ("nature", "sunrise-sunset"), 3), ("hdris", ("snow",), 2),
    ("hdris", ("desert",), 2), ("hdris", ("forest",), 2),
    ("models", ("furniture",), 10), ("models", ("tools",), 8), ("models", ("electronics",), 5),
    ("models", ("appliances",), 4), ("models", ("food",), 6), ("models", ("plants",), 6), ("models", ("rocks",), 6),
    ("models", ("nature",), 8), ("models", ("industrial",), 8), ("models", ("containers",), 6),
    ("models", ("lighting",), 4), ("models", ("structures",), 4), ("models", ("decorative",), 5),
    ("models", ("props",), 10),
]


def _get(url):
    if not url.startswith(("https://api.polyhaven.com/", DOWNLOAD_PREFIX)):
        raise ValueError(f"refused url outside Poly Haven: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read(MAX_FILE_BYTES + 1)


def remote_assets(kind):
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    return json.loads(_get(f"{API}/assets?t={kind}"))


def _words(info):
    parts = [info.get("name", ""), info.get("category", ""), " ".join(info.get("categories", [])),
             " ".join(info.get("tags", [])), " ".join(str(v) for v in (info.get("attributes") or {}).values())]
    return " ".join(parts).lower().replace("_", " ")


def search(assets, words):
    words = [w.lower() for w in words]
    hits = [(i, a) for i, a in assets.items() if all(w in _words(a) for w in words)]
    return sorted(hits, key=lambda x: -int(x[1].get("download_count", 0)))


def _download(url, dest, md5, size):
    if dest.is_file() and hashlib.md5(dest.read_bytes()).hexdigest() == md5:
        return False
    if size > MAX_FILE_BYTES:
        raise ValueError(f"file too large ({size} bytes): {url}")
    data = _get(url)
    if len(data) != size or hashlib.md5(data).hexdigest() != md5:
        raise ValueError(f"size or md5 mismatch for {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    return True


def _entry(asset_id, kind, info, rel_file, md5, res):
    e = {
        "id": asset_id, "kind": "hdri" if kind == "hdris" else "model", "name": info.get("name", asset_id),
        "file": rel_file, "res": res, "md5": md5, "category": info.get("category", ""),
        "tags": info.get("tags", []), "description": info.get("description", ""),
        "authors": sorted((info.get("authors") or {}).keys()), "licence": "CC0-1.0",
        "source": f"https://polyhaven.com/a/{asset_id}",
    }
    if kind == "hdris":
        e["attributes"] = info.get("attributes") or {}
    else:
        e["polycount"] = info.get("polycount")
        dims = info.get("dimensions") or []
        # Poly Haven gives millimetres (x, y, z-up as authored); the library speaks metres.
        e["dimensions_m"] = [round(float(d) / 1000.0, 4) for d in dims[:3]]
    return e


def fetch(kind, asset_id, root=DEFAULT_ROOT, info=None):
    """Download one asset, verify every file against the API's md5, and return its catalog entry."""
    if not SAFE_ID.match(asset_id):
        raise ValueError(f"bad asset id: {asset_id!r}")
    root = Path(root)
    info = info if info is not None else remote_assets(kind)[asset_id]
    files = json.loads(_get(f"{API}/files/{asset_id}"))
    if kind == "hdris":
        f = files["hdri"][HDRI_RES]["hdr"]
        rel = f"polyhaven/hdris/{asset_id}_{HDRI_RES}.hdr"
        _download(f["url"], root / rel, f["md5"], f["size"])
        return _entry(asset_id, kind, info, rel, f["md5"], HDRI_RES)
    if info.get("polycount") and info["polycount"] > MAX_POLYCOUNT:
        raise ValueError(f"{asset_id}: {info['polycount']} polygons is over the {MAX_POLYCOUNT} cap")
    f = files["blend"][MODEL_RES]["blend"]
    folder = f"polyhaven/models/{asset_id}"
    rel = f"{folder}/{asset_id}_{MODEL_RES}.blend"
    for name, inc in (f.get("include") or {}).items():
        if not SAFE_REL.match(name) or ".." in name or name.startswith("/"):
            raise ValueError(f"{asset_id}: refused include path {name!r}")
        _download(inc["url"], root / folder / name, inc["md5"], inc["size"])
    _download(f["url"], root / rel, f["md5"], f["size"])
    return _entry(asset_id, kind, info, rel, f["md5"], MODEL_RES)


def load_catalog(root=DEFAULT_ROOT):
    p = Path(root) / "catalog.json"
    if not p.is_file():
        return {"version": 1, "assets": []}
    return json.loads(p.read_text(encoding="utf-8"))


def save_entry(entry, root=DEFAULT_ROOT):
    cat = load_catalog(root)
    cat["assets"] = sorted([a for a in cat["assets"] if a["id"] != entry["id"]] + [entry],
                           key=lambda a: (a["kind"], a["id"].lower()))
    p = Path(root) / "catalog.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cat, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def starter_ids(remote):
    """Deterministic pick: the most downloaded assets per bucket; an asset is taken once."""
    taken, out = set(), []
    for kind, words, n in STARTER:
        got = 0
        for asset_id, info in search(remote[kind], words):
            if got >= n:
                break
            if asset_id in taken or not SAFE_ID.match(asset_id):
                continue
            if kind == "models" and (str(info.get("category", "")).lower().split("/")[0] == "weapons"
                                     or re.search(r"rifle|sword|katana|cannon", asset_id, re.I)):
                continue
            if kind == "models" and (info.get("polycount") or 0) > MAX_POLYCOUNT:
                continue
            taken.add(asset_id)
            out.append((kind, asset_id))
            got += 1
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=str(DEFAULT_ROOT))
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search"); s.add_argument("kind", choices=KINDS); s.add_argument("words", nargs="*")
    f = sub.add_parser("fetch"); f.add_argument("kind", choices=KINDS); f.add_argument("ids", nargs="+")
    sub.add_parser("starter")
    sub.add_parser("list")
    a = ap.parse_args(argv)
    if a.cmd == "search":
        for asset_id, info in search(remote_assets(a.kind), a.words)[:40]:
            print(f"{asset_id:45s} {info.get('category', '')}")
    elif a.cmd == "fetch":
        remote = remote_assets(a.kind)
        for asset_id in a.ids:
            save_entry(fetch(a.kind, asset_id, a.root, remote[asset_id]), a.root)
            print("ok", asset_id)
    elif a.cmd == "starter":
        remote = {k: remote_assets(k) for k in KINDS}
        failed = 0
        for kind, asset_id in starter_ids(remote):
            try:
                save_entry(fetch(kind, asset_id, a.root, remote[kind][asset_id]), a.root)
                print("ok", kind, asset_id, flush=True)
            except Exception as e:  # one bad asset must not stop the set
                failed += 1
                print("FAILED", kind, asset_id, e, flush=True)
        return 1 if failed else 0
    else:
        for e in load_catalog(a.root)["assets"]:
            print(f"{e['kind']:6s} {e['id']:45s} {e['category']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
