# Shared fixtures for `overlay.json` (contract 2.3)

Owner: lane KO1 (plan `ForgeBrain/plans/2026-11-17-kola-into-pipeline-fleet-plan.md`, section 2.3). This folder is the one place
both readers of `overlay.json` are tested against, so they cannot drift apart:

- Python: `narrative_factory/codebuilt/post/overlay.py` `load_spec` / `validate_spec`
  (tested by `narrative_factory/tests/test_overlay_spec.py`).
- JavaScript: `dashboard/server/episode/codebuilt/overlaySpec.js` `validateOverlaySpec` (lane KB1). Its test must walk
  `cases.json` the same way.

## How to use it

`cases.json` lists every case: `file` (relative to this folder), `videoSeconds` (a number, or `null` to skip the
"`to` inside the video" check), `ok`, and for an invalid case the one expected error `code` and `where`.
Each invalid file breaks exactly one rule, so the code and place are the same whatever order a reader checks in.

A reader takes the file as **raw text**: size check, then `JSON.parse` / `json.loads`, then the rules below.
Do not edit a fixture by hand without running both test suites; add new cases to `cases.json`.

## The rules (both readers)

| Rule | Error code | `where` |
|---|---|---|
| More than 65536 bytes of UTF-8 text | `too_large` | `""` |
| Not JSON (includes `NaN`, `Infinity`, a cut-off file) | `not_json` | `""` |
| Top level is not an object | `not_object` | `""` |
| A key that is not in the schema, at any level | `unknown_key` | path of the key, e.g. `counter.color` |
| A required key is missing | `missing_key` | path of the key |
| `version` is not the number 1 (`true` and `"1"` are wrong) | `bad_version` | `version` |
| `counter`/`tag` not an object, `labels`/`measures`/`bars`/`big` not an array, an item not an object, a name or text that is not a string | `bad_type` | path |
| More than 12 labels, 4 measures, 2 bars, 3 big numbers | `too_many` | the list, e.g. `labels` |
| A name (`value`, `anchor`, `a`, `b`) not matching `^[a-z][a-z0-9_]{0,23}$` | `bad_name` | path |
| Text not made only of `A-Z a-z 0-9`, space and `. , % ° × - + / : ' ( )`, or empty, or only spaces | `bad_text` | path |
| Text longer than 28 characters (`sub` 40) | `text_length` | path |
| A number field (`from`, `to`, `min`, `max`) that is not a finite number (`true`, `"7"`, `1e400` are wrong) | `bad_number` | path |
| `format` not one of `int`, `int_commas`, `one_decimal`, `two_decimals`, `year`, `times` | `bad_format` | path |
| `side` not one of `left`, `right`, `auto` | `bad_side` | path |
| `from < 0`, or `from >= to`, or `to > videoSeconds` | `bad_time` | the element, e.g. `labels[0]` |
| A bar with `min >= max` | `bad_range` | the element |
| A measure with `a == b` | `same_anchor` | the element |

Paths: `labels[0].title`, `counter.format`, `tag`, `version`. The root is `""`.

### Schema
Every element is optional; `version` is required.

| Element | Required keys | Optional keys |
|---|---|---|
| `counter` (object) | `value` (name), `format`, `from`, `to` | `unit` (text 28), `label` (text 28) |
| `labels[]` (max 12) | `anchor` (name), `title` (text 28), `from`, `to` | `value` (text 28), `side` (default `auto`) |
| `measures[]` (max 4) | `a` (name), `b` (name), `text` (text 28), `from`, `to` | |
| `bars[]` (max 2) | `value` (name), `min`, `max`, `from`, `to` | `label` (text 28) |
| `big[]` (max 3) | `text` (text 28), `from`, `to` | `sub` (text 40) |
| `tag` (object) | `text` (text 28), `from`, `to` | |

`null` is never allowed as a value (an optional key is either absent or valid).

"Letters" means ASCII `A-Z a-z` only. Character counts are code points; the allowed characters are all in the
Basic Multilingual Plane, and the character check runs before the length check, so JavaScript `.length` gives the
same answer. Duplicate keys are not checked (`JSON.parse` cannot see them).

Not checked here, on purpose: that each name is marked in the scene code (KB1, `validateBuildScript`), and that a name
exists in `anchors.json` (the post step reports a label that is hidden too long as a layout finding).
