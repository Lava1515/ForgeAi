from types import SimpleNamespace

from blender_worker.codebuilt.shotcheck import BlenderProbe


class _Collection:
    def __init__(self, objects):
        self.objects = objects
        self.children = []
        self.hide_render = False


class _Font:
    name = "background_title"
    type = "FONT"
    hide_render = False
    instance_collection = None

    def __init__(self):
        self.matrix_world = SimpleNamespace(to_scale=lambda: (1.0, 1.0, 1.0))


def test_text_in_3d_finds_visible_fonts_across_background_set_chain_and_cycles():
    font = _Font()
    leaf = SimpleNamespace(collection=_Collection([font]), background_set=None)
    middle = SimpleNamespace(collection=_Collection([]), background_set=leaf)
    main = SimpleNamespace(collection=_Collection([]), background_set=middle)
    leaf.background_set = main  # malformed cyclic scene chain must terminate safely
    probe = BlenderProbe.__new__(BlenderProbe)
    probe.scene = main
    probe.bpy = SimpleNamespace(context=SimpleNamespace(evaluated_depsgraph_get=lambda: (_ for _ in ()).throw(RuntimeError())))

    assert [obj.name for obj in probe.text_in_3d_objects()] == ["background_title"]
