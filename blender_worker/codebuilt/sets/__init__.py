"""Code-built set library (KAN-911, CB2).

Eight scenery sets ported from the chat builds as modules. Each module exposes
`build(origin=(0, 0, 0))` which builds the set with its centre at `origin` in its own
collection and returns a handles dict (see `common.REQUIRED_HANDLES`).

`registry` is pure Python (no Blender): names, one-line descriptions for the theme
picker, three preview camera angles and scene parameters (world, exposure) per set.
Every path argument elsewhere in this package must be absolute.
"""
