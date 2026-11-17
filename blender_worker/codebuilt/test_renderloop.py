import os
import tempfile
import unittest
from unittest import mock

from blender_worker.codebuilt import renderloop


class RenderFramesRamCopyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ram_patch = mock.patch.object(renderloop, 'RAM_FRAME_DIR', self.tmp.name)
        self.ram_patch.start()
        self.addCleanup(self.ram_patch.stop)
        self.out = os.path.join(self.tmp.name, 'frames')
        os.makedirs(self.out)

    def render_fn(self, events):
        def render(path):
            frame = int(os.path.basename(path)[:4])
            events.append(('render', frame))
            with open(path, 'wb') as f:
                f.write(f'frame-{frame}'.encode())
        return render

    def test_frames_copy_in_order_from_ram_and_are_removed(self):
        events = []
        real_copy = renderloop._copy_frame
        copies = []

        def record_copy(src, dst):
            copies.append((src, dst))
            real_copy(src, dst)

        with mock.patch.object(renderloop, '_copy_frame', side_effect=record_copy):
            rendered = renderloop.render_frames([2, 1, 3], self.out, lambda f: events.append(('apply', f)),
                                                self.render_fn(events), log=lambda _: None)

        self.assertEqual(rendered, [2, 1, 3])
        self.assertEqual([e[1] for e in events if e[0] == 'apply'], [2, 1, 3])
        self.assertEqual([os.path.basename(dst) for _, dst in copies], ['0002.png', '0001.png', '0003.png'])
        self.assertTrue(all(not os.path.exists(src) for src, _ in copies))
        self.assertEqual(sorted(os.listdir(self.out)), ['0001.png', '0002.png', '0003.png'])

    def test_resume_skips_only_existing_final_files(self):
        with open(os.path.join(self.out, '0001.png'), 'wb') as f:
            f.write(b'complete')
        with open(os.path.join(self.out, '0002.png.part'), 'wb') as f:
            f.write(b'incomplete')
        events = []
        rendered = renderloop.render_frames([1, 2], self.out, lambda f: events.append(f), self.render_fn([]), log=lambda _: None)
        self.assertEqual(rendered, [2])
        self.assertEqual(events, [2])
        with open(os.path.join(self.out, '0001.png'), 'rb') as f:
            self.assertEqual(f.read(), b'complete')

    def test_copy_failure_is_raised_and_not_reported_done(self):
        events = []
        with mock.patch.object(renderloop, '_copy_frame', side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError, 'disk full'):
                renderloop.render_frames([1], self.out, lambda f: None, self.render_fn(events), log=lambda _: None)
        self.assertEqual([e[1] for e in events if e[0] == 'render'], [1])
        self.assertFalse(os.path.exists(os.path.join(self.out, '0001.png')))

    def test_ram_disk_full_render_error_propagates_and_cleans_temporary_frames(self):
        def full_disk(_path):
            raise OSError('No space left on device')

        with self.assertRaisesRegex(OSError, 'No space left on device'):
            renderloop.render_frames([1], self.out, lambda _: None, full_disk, log=lambda _: None)
        self.assertEqual(os.listdir(self.tmp.name), ['frames'])

    def test_held_frame_waits_for_source_copy_then_uses_complete_file(self):
        events = []
        rendered = renderloop.render_frames([0, 1, 2], self.out, lambda f: None, self.render_fn(events), hold=2, log=lambda _: None)
        self.assertEqual(rendered, [0, 2])
        with open(os.path.join(self.out, '0000.png'), 'rb') as a, open(os.path.join(self.out, '0001.png'), 'rb') as b:
            self.assertEqual(a.read(), b.read())


if __name__ == '__main__':
    unittest.main()
