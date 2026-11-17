// claude-pro · claude-sonnet-5-5 · 2026-11-17: O1c-http. The HTTP handlers let the optional key route through unchanged;
// the real checks stay in start.js (checkStartRequest) and runCoordinator.js (checkRunRequest). The stubs below call those
// same checks, so nothing here validates route on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStartRequest, setCodebuiltStarter } from '../episode/codebuilt/start.js';
import { checkRunRequest, setCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';
import { startCodebuiltHandler } from '../routes/codebuilt.js';
import { startCodebuiltRunHandler, RUN_BODY_KEYS } from '../routes/codebuiltRuns.js';

const call = async (handler, body) => {
  const out = {};
  const res = { status(code) { out.status = code; return this; }, json(value) { out.json = value; return this; } };
  await handler(body === undefined ? {} : { body }, res);
  return out;
};
const withFlag = async (value, task) => {
  const old = process.env.FORGEAI_AUTHOR_MODE;
  if (value === undefined) delete process.env.FORGEAI_AUTHOR_MODE; else process.env.FORGEAI_AUTHOR_MODE = value;
  try { await task(); } finally { if (old === undefined) delete process.env.FORGEAI_AUTHOR_MODE; else process.env.FORGEAI_AUTHOR_MODE = old; }
};

function singleStub() {
  const seen = [];
  setCodebuiltStarter({ start(input) { seen.push(input); const req = checkStartRequest(input); return { id: 'job1', route: req.route }; } });
  return seen;
}
function runStub() {
  const seen = [];
  setCodebuiltRunCoordinator({ startRun(input) { seen.push(input); const req = checkRunRequest(input); return { id: 'run1', route: req.route }; } });
  return seen;
}
const reset = () => { setCodebuiltStarter(null); setCodebuiltRunCoordinator(null); };
const single = (extra) => ({ topic: 'How a bridge holds a train', duration: 30, channelId: 'c1', ...extra });
const run = (extra) => ({ count: 1, channelId: 'c1', ...extra });

test('the run body key list names route', () => { assert.ok(RUN_BODY_KEYS.includes('route')); });

for (const route of ['classic', 'overlay']) {
  test(`single start accepts route ${route} and forwards it unchanged`, async () => {
    const seen = singleStub();
    try {
      const out = await call(startCodebuiltHandler, single({ route }));
      assert.equal(out.status, 202);
      assert.equal(out.json.route, route);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].route, route);
    } finally { reset(); }
  });
  test(`run start accepts route ${route} and forwards it unchanged`, async () => {
    const seen = runStub();
    try {
      const out = await call(startCodebuiltRunHandler, run({ route }));
      assert.equal(out.status, 202);
      assert.equal(out.json.route, route);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].route, route);
    } finally { reset(); }
  });
}

test('single start: a bogus route gives bad_request and an absent route stays absent', async () => {
  const seen = singleStub();
  try {
    for (const route of ['bogus', 'Classic', '', null, 5, ['overlay']]) {
      const out = await call(startCodebuiltHandler, single({ route }));
      assert.equal(out.status, 400, `route ${JSON.stringify(route)}`);
      assert.equal(out.json.code, 'bad_request');
    }
    const absent = await call(startCodebuiltHandler, single());
    assert.equal(absent.status, 202);
    assert.equal(Object.hasOwn(seen.at(-1), 'route'), false);
    assert.equal(absent.json.route, 'classic');
  } finally { reset(); }
});

test('run start: a bogus route gives bad_request and an absent route stays absent', async () => {
  const seen = runStub();
  try {
    for (const route of ['bogus', 'Classic', '', null, 5, ['overlay']]) {
      const out = await call(startCodebuiltRunHandler, run({ route }));
      assert.equal(out.status, 400, `route ${JSON.stringify(route)}`);
      assert.equal(out.json.code, 'bad_request');
    }
    const absent = await call(startCodebuiltRunHandler, run());
    assert.equal(absent.status, 202);
    assert.equal(Object.hasOwn(seen.at(-1), 'route'), false);
    assert.equal(absent.json.route, 'classic');
  } finally { reset(); }
});

test('authored without the dashboard flag gives 409 author_mode_disabled on both paths', async () => {
  singleStub(); runStub();
  try {
    for (const flag of [undefined, '', '0', 'true']) {
      await withFlag(flag, async () => {
        for (const [handler, body] of [[startCodebuiltHandler, single({ route: 'authored' })], [startCodebuiltRunHandler, run({ route: 'authored' })]]) {
          const out = await call(handler, body);
          assert.equal(out.status, 409, `flag ${JSON.stringify(flag)}`);
          assert.equal(out.json.code, 'author_mode_disabled');
        }
      });
    }
    // The request body cannot switch the flag on.
    const forged = await call(startCodebuiltRunHandler, run({ route: 'authored', FORGEAI_AUTHOR_MODE: '1' }));
    assert.equal(forged.status, 400);
  } finally { reset(); }
});

test('authored is passed through when the process flag is exactly 1', async () => {
  const one = singleStub(); const two = runStub();
  try {
    await withFlag('1', async () => {
      assert.equal((await call(startCodebuiltHandler, single({ route: 'authored' }))).status, 202);
      assert.equal((await call(startCodebuiltRunHandler, run({ route: 'authored' }))).status, 202);
    });
    assert.equal(one.at(-1).route, 'authored');
    assert.equal(two.at(-1).route, 'authored');
  } finally { reset(); }
});
