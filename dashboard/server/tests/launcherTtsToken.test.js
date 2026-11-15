import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTtsToken, startHostDashboard } from '../../../scripts/supervisor/start_codebuilt_dashboard.mjs';

test('launcher loads only TTS_TOKEN using .env syntax when process env omits it', () => {
  const contents = [
    '# ignored comment',
    'OTHER_KEY=not-copied',
    'export TTS_TOKEN="fixture token # preserved" # trailing comment',
    '',
  ].join('\n');

  const env = {};
  const token = loadTtsToken('C:/code/launcher-fixture', { env, readFile: () => contents });
  assert.equal(token, 'fixture token # preserved');
  assert.deepEqual(env, {});
});

test('an explicitly supplied process token wins without reading .env', () => {
  const env = { TTS_TOKEN: 'provided fixture' };
  const token = loadTtsToken('unused-root', {
    env,
    readFile: () => { throw new Error('must not read .env'); },
  });
  assert.equal(token, 'provided fixture');
});

test('an absent .env file leaves TTS_TOKEN unset', () => {
  assert.equal(loadTtsToken('C:/code/launcher-fixture', {
    env: {},
    readFile: () => { throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); },
  }), undefined);
});

test('an explicitly present empty process token is preserved', () => {
  assert.equal(loadTtsToken('unused-root', { env: { TTS_TOKEN: '' } }), '');
});

test('launcher applies the root token without applying other .env keys', async () => {
  const root = 'C:/code/launcher-fixture';
  let applied;
  await startHostDashboard({
    root,
    env: {},
    readFile: () => 'TTS_TOKEN=fixture-token\nOTHER_KEY=not-copied\n',
    exists: () => true,
    log: () => {},
    autoRelease: false,
    apply: (vars) => { applied = vars; },
    importApp: async () => ({
      createApp: () => ({
        listen: (_port, _host, onListen) => {
          const server = { on() { return this; } };
          queueMicrotask(onListen);
          return server;
        },
      }),
    }),
  });
  assert.equal(applied.TTS_TOKEN, 'fixture-token');
  assert.equal(Object.hasOwn(applied, 'OTHER_KEY'), false);
});
