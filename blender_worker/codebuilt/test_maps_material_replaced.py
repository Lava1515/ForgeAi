"""claude-pro · claude-fable-5-2 · 2026-11-20: job mwns1inh-0cdbd0 replaced Australia's kit material and the map went flat."""
import sys
import types

from blender_worker.codebuilt import maps, shotcheck


def _country(name):
    return types.SimpleNamespace(data=types.SimpleNamespace(materials=[types.SimpleNamespace(name=name)]))


def test_replaced_country_material_is_reported_as_a_finding(monkeypatch):
    wm = types.SimpleNamespace(objs={"AUS": _country("map_AUS"), "NZL": _country("map_NZL")}, _kit_top={"AUS": "map_AUS", "NZL": "map_NZL"})
    monkeypatch.setattr(maps, "_BUILT", [wm])
    monkeypatch.setitem(sys.modules, shotcheck.__package__ + ".maps", maps)
    assert maps.replaced_country_materials() == []
    assert shotcheck.map_material_findings() == []
    wm.objs["AUS"].data.materials[:] = [types.SimpleNamespace(name="aus")]     # what the Dingo Fence build did
    assert maps.replaced_country_materials() == ["AUS"]
    found = shotcheck.map_material_findings()
    assert [f["check"] for f in found] == ["map_material_replaced"] and "AUS" in found[0]["text"]
    wm.objs["NZL"].data = None      # a removed object is skipped, never an error
    assert maps.replaced_country_materials() == ["AUS"]
