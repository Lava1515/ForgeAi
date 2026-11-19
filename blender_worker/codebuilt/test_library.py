"""Asset library: the catalog functions that run without Blender. A job must never reach a file outside the library.
Author: claude-pro · claude-fable-5-2, 2026-11-19.
"""
import json

import pytest

from blender_worker.codebuilt import library


def _lib(tmp_path, assets):
    tmp_path.mkdir(parents=True, exist_ok=True)
    for a in assets:
        f = tmp_path / a["file"]
        if ".." not in a["file"]:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(b"x")
    (tmp_path / "catalog.json").write_text(json.dumps({"version": 1, "assets": assets}), encoding="utf-8")
    return tmp_path


def test_find_and_get(tmp_path):
    root = _lib(tmp_path, [
        {"id": "Drill_01", "kind": "model", "name": "Drill 01", "file": "polyhaven/models/Drill_01/Drill_01_1k.blend", "category": "Tools/Drills", "tags": ["tool"]},
        {"id": "sunset_sky", "kind": "hdri", "name": "Sunset", "file": "polyhaven/hdris/sunset_sky_2k.hdr", "attributes": {"time_of_day": "sunset"}},
    ])
    assert [e["id"] for e in library.find("drill tool", root=root)] == ["Drill_01"]
    assert [e["id"] for e in library.find("sunset", kind="hdri", root=root)] == ["sunset_sky"]
    entry, path = library.get("Drill_01", root=root)
    assert path.is_file() and entry["kind"] == "model"
    with pytest.raises(library.LibraryError, match="nearest"):
        library.get("drill", root=root)


def test_get_refuses_a_file_outside_the_library(tmp_path):
    (tmp_path / "secret.blend").write_bytes(b"x")
    root = _lib(tmp_path / "lib", [{"id": "evil", "kind": "model", "name": "evil", "file": "../secret.blend"}])
    with pytest.raises(library.LibraryError, match="missing"):
        library.get("evil", root=root)


def test_no_catalog_is_an_empty_library(tmp_path):
    assert library.catalog(tmp_path) == [] and library.picker_text(tmp_path) == ""
