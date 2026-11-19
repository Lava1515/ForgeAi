"""Copy the built people into the library and add them to catalog.json. Run: python merge_people.py <people dir> <assets root>"""
import json, shutil, sys
from pathlib import Path
src, root = Path(sys.argv[1]), Path(sys.argv[2])
(root / "people").mkdir(parents=True, exist_ok=True)
cat_path = root / "catalog.json"
cat = json.loads(cat_path.read_text(encoding="utf-8")) if cat_path.is_file() else {"version": 1, "assets": []}
new = json.loads((src / "people.json").read_text(encoding="utf-8"))
for e in new:
    shutil.copyfile(src / (e["id"] + ".blend"), root / e["file"])
ids = {e["id"] for e in new}
cat["assets"] = sorted([a for a in cat["assets"] if a["id"] not in ids] + new, key=lambda a: (a["kind"], a["id"].lower()))
cat_path.write_text(json.dumps(cat, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
print(len(new), "people merged;", len(cat["assets"]), "assets")
