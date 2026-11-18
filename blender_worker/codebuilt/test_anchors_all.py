# claude-pro · claude-sonnet-5-5 · 2026-11-18 (C2-AUTH-1): all-frame anchor export of an overlay preview, without rendering.
import json
import os
import tempfile
import unittest
from unittest import mock

from blender_worker.codebuilt import anchors, renderloop, shotcheck


def preview_spec(frames, out):
    return {"version": 1, "frames": frames, "scale": 50, "out": out}


class AllFrameAnchorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        t = self.tmp.name
        self.paths = {
            'RAM_FRAME_DIR': t, 'PREVIEW_OUT': os.path.join(t, 'preview'), 'PREVIEW_SPEC': os.path.join(t, 'preview.json'),
            'PREVIEW_ANCHORS_PATH': os.path.join(t, 'anchors-preview.json'), 'ANCHORS_PATH': os.path.join(t, 'anchors.json'),
            'ALL_ANCHORS_PATH': os.path.join(t, 'anchors-all.json'), 'ALL_ANCHORS_DONE_PATH': os.path.join(t, 'anchors-all.done.json'),
            'OVERLAY_SPEC_PATH': os.path.join(t, 'overlay.json'), 'TIMING_PATH': os.path.join(t, 'render-timing.json'),
        }
        for name, value in self.paths.items():
            patcher = mock.patch.object(renderloop, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for patcher in (mock.patch.object(renderloop, '_anchor_dimensions', return_value=(1080, 1920)),
                        mock.patch.object(renderloop, 'set_preview_scale'),
                        mock.patch.object(shotcheck, 'require_qa')):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.rendered, self.posed = [], []

    def write_spec(self, frames):
        with open(self.paths['PREVIEW_SPEC'], 'w', encoding='utf-8') as fh:
            json.dump(preview_spec(frames, self.paths['PREVIEW_OUT']), fh)

    def write_overlay(self):
        with open(self.paths['OVERLAY_SPEC_PATH'], 'w', encoding='utf-8') as fh:
            fh.write('{}')

    def render_fn(self, path):
        self.rendered.append(int(os.path.basename(path)[:4]))
        with open(path, 'wb') as fh:
            fh.write(b'png')

    def run_loop(self, nframes, apply, project):
        def tracking(f):
            self.posed.append(f)
            apply(f)
        with mock.patch.object(renderloop, '_project_anchor', side_effect=project):
            return renderloop.render_frames(range(nframes), self.paths['PREVIEW_OUT'], tracking,
                                            self.render_fn, skip_existing=False, log=lambda _m: None, require_qa=True)

    def load(self, name):
        with open(self.paths[name], 'r', encoding='utf-8') as fh:
            return json.load(fh)

    def test_every_frame_is_posed_and_exported_but_only_preview_frames_render(self):
        self.write_spec([2, 6]); self.write_overlay()
        # the pin is behind the camera only between the two previewed frames (frames 3 and 4)
        def apply(f):
            anchors.mark('pin', (f, 0, 0))
            anchors.value('depth', f * 10)
        def project(point):
            return (0.5, 0.25, -1.0 if point[0] in (3, 4) else 2.0)
        done = self.run_loop(8, apply, project)
        self.assertEqual(done, [2, 6])
        self.assertEqual(self.rendered, [2, 6])
        self.assertEqual(sorted(os.listdir(self.paths['PREVIEW_OUT'])), ['0002.png', '0006.png'])
        self.assertEqual(self.posed, [2, 6] + list(range(8)))
        preview = self.load('PREVIEW_ANCHORS_PATH')
        self.assertEqual(sorted(preview['frames'], key=int), ['2', '6'])
        everything = self.load('ALL_ANCHORS_PATH')
        self.assertEqual(sorted(everything['frames'], key=int), [str(i) for i in range(8)])
        self.assertEqual((everything['version'], everything['width'], everything['height']), (1, 1080, 1920))
        self.assertEqual(everything['frames']['3']['p']['pin'], [0.5, 0.25, 0])
        self.assertEqual(everything['frames']['4']['p']['pin'], [0.5, 0.25, 0])
        self.assertEqual(everything['frames']['5']['p']['pin'], [0.5, 0.25, 1])
        self.assertEqual(everything['frames']['5']['v']['depth'], 50)
        # the preview file keeps exactly the values of the same frames in the all-frame file
        for key in preview['frames']:
            self.assertEqual(preview['frames'][key], everything['frames'][key])
        record = self.load('ALL_ANCHORS_DONE_PATH')
        self.assertEqual((record['version'], record['frames'], record['max_frame'], record['anchors']), (1, 8, 7, True))

    def test_exported_file_obeys_the_untrusted_reader_contract(self):
        from narrative_factory.codebuilt.post import anchors_file
        self.write_spec([0]); self.write_overlay()
        self.run_loop(6, lambda f: anchors.mark('pin', (f, 0, 0)), lambda p: (0.4, 0.6, 3.0))
        with open(self.paths['ALL_ANCHORS_PATH'], 'rb') as fh:
            parsed = anchors_file.parse(fh.read(), 6)
        self.assertEqual([parsed.point(f, 'pin') for f in range(6)], [(0.4, 0.6, True)] * 6)

    def test_classic_preview_without_overlay_input_is_unchanged(self):
        self.write_spec([2])
        self.run_loop(6, lambda f: None, lambda p: (0.5, 0.5, 1.0))
        self.assertEqual(self.posed, [2])
        self.assertFalse(os.path.exists(self.paths['ALL_ANCHORS_PATH']))
        self.assertFalse(os.path.exists(self.paths['ALL_ANCHORS_DONE_PATH']))

    def test_final_render_does_not_export(self):
        self.write_overlay()
        with mock.patch.object(renderloop, '_project_anchor', return_value=(0.5, 0.5, 1.0)):
            renderloop.render_frames(range(3), self.paths['PREVIEW_OUT'], lambda f: anchors.mark('pin', (0, 0, 0)), self.render_fn,
                                     skip_existing=False, log=lambda _m: None, require_qa=True)
        self.assertFalse(os.path.exists(self.paths['ALL_ANCHORS_PATH']))
        self.assertFalse(os.path.exists(self.paths['ALL_ANCHORS_DONE_PATH']))
        self.assertTrue(os.path.exists(self.paths['ANCHORS_PATH']))

    def test_pass_with_no_marks_writes_only_the_record_and_removes_a_stale_file(self):
        self.write_spec([0]); self.write_overlay()
        with open(self.paths['ALL_ANCHORS_PATH'], 'w') as fh:
            fh.write('stale')
        self.run_loop(4, lambda f: None, lambda p: (0.5, 0.5, 1.0))
        self.assertFalse(os.path.exists(self.paths['ALL_ANCHORS_PATH']))
        self.assertEqual(self.load('ALL_ANCHORS_DONE_PATH')['anchors'], False)
        self.assertEqual(self.load('ALL_ANCHORS_DONE_PATH')['frames'], 4)

    def test_a_frame_that_cannot_be_posed_stops_the_export_without_a_record(self):
        self.write_spec([0]); self.write_overlay()
        def apply(f):
            if f == 5:
                raise RuntimeError('frame 5 broke')
            anchors.mark('pin', (f, 0, 0))
        with self.assertRaisesRegex(RuntimeError, 'frame 5 broke'):
            self.run_loop(8, apply, lambda p: (0.5, 0.5, 1.0))
        self.assertFalse(os.path.exists(self.paths['ALL_ANCHORS_DONE_PATH']))
        self.assertFalse(os.path.exists(self.paths['ALL_ANCHORS_PATH']))

    def test_export_renders_nothing_and_leaves_no_image(self):
        self.write_spec([2]); self.write_overlay()
        events = []
        record = renderloop.export_all_frame_anchors([3, 1, 2], lambda f: (events.append(f), anchors.mark('pin', (0, 0, 0))),
                                                     log=lambda _m: None, project=lambda p: (0.1, 0.2, 1.0))
        self.assertEqual(events, [1, 2, 3])
        self.assertEqual(record['frames'], 3)
        self.assertEqual(os.path.exists(self.paths['PREVIEW_OUT']), False)


if __name__ == '__main__':
    unittest.main()
