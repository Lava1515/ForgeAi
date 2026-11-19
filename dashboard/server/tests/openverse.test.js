// Licence gate regressions: codex · gpt-6.1-sol · 2026-11-19 14:50 +02:00.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getOpenverseAsset, evaluatePageLicense, verifyOpenverseItem } from '../episode/codebuilt/openverse.js';
import { JOB_ROOT } from '../episode/codebuilt/jobPaths.js';
const own = 'https://freesound.org/people/artist/sounds/12345/';
const cc0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
const pdm = 'https://creativecommons.org/publicdomain/mark/1.0/';
const by = 'https://creativecommons.org/licenses/by/4.0/';
const link = url => `<a href="${url}">Licence</a>`;
const scope = html => `<div id="sound_license">${html}</div>`;
const valid = scope(link(cc0));
const item = (id = 'safe', extra = {}) => ({ id, license: 'cc0', foreign_landing_url: own, url: `https://cdn.freesound.org/${id}.mp3`, creator: 'Artist', title: 'Ocean', ...extra });
const lookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
function job(t) {
  const dir = fs.mkdtempSync(path.join(JOB_ROOT, 'c2-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}
function network(items, pages = {}, assets = {}) {
  const calls = [];
  return { lookupFn, calls, fetchFn: async (url, opts) => {
    assert.equal(opts.redirect, 'manual'); assert.ok(opts.signal); calls.push(url);
    if (url.startsWith('https://api.openverse.org/')) return Response.json({ results: items });
    const response = pages[url] ?? assets[url];
    if (response instanceof Error) throw response;
    if (typeof response === 'function') return response();
    if (response !== undefined) return new Response(response);
    throw new Error(`Unexpected fetch ${url}`);
  } };
}
test('scoped parser rejects sidebar, negation, substring, text-only and conflicting evidence', () => {
  const bad = [scope(link(by)) + `<aside>${link(cc0)}</aside>`, scope('Not dedicated to the public domain'),
    scope(`Not dedicated to the public domain ${link(cc0)}`), scope(`N&#111;t dedicated ${link(cc0)}`), scope(link('https://notcreativecommons.org/publicdomain/zero/1.0/')),
    scope(link('https://creativecommons.org.evil.test/publicdomain/zero/1.0/')), scope('CC0'),
    scope(link('https://creativecommons.org/publicdomain/zero/1.0/extra')), scope(link(cc0) + link(by)), scope(link(cc0) + link(pdm)),
    scope(`<!-- ${link(cc0)} -->CC0`), scope(`<script>${link(cc0)}</script>`), `<aside>${link(cc0)}</aside>`,
    `<!-- ${valid}`, `<div id="comments" id="sound_license">${link(cc0)}</div>`];
  for (const html of bad) assert.equal(evaluatePageLicense(html, { url: own }).confirmed, false, html);
  assert.equal(evaluatePageLicense(valid, { url: own }).licenseTag, 'cc0');
  assert.equal(evaluatePageLicense(scope(link(pdm)), { url: own }).licenseTag, 'pdm');
  assert.equal(evaluatePageLicense(valid, { url: 'https://unknown.test/item' }).confirmed, false);
});
test('Commons requires file page and checks every media licence template', () => {
  const url = 'https://commons.wikimedia.org/wiki/File:Ocean.jpg';
  const table = html => `<table class="licensetpl"><tr><td>${html}</td></tr></table>`;
  assert.equal(evaluatePageLicense(table(link(cc0)) + link(by), { url }).confirmed, true);
  assert.equal(evaluatePageLicense(table(link(cc0)) + table(link(by)), { url }).confirmed, false);
  assert.equal(evaluatePageLicense(table(link(cc0)), { url: own }).confirmed, false);
  assert.equal(evaluatePageLicense(link(cc0), { url }).confirmed, false);
});
test('API tag and own-page provenance must match exactly', async () => {
  const net = network([], { [own]: valid });
  for (const candidate of [item('by', { license: 'by' }), item('mismatch', { license: 'pdm' }), item('detail', { foreign_landing_url: null, detail_url: own })]) {
    assert.equal((await verifyOpenverseItem(candidate, net)).ok, false);
  }
});
test('rejected items never download; accepted asset records confirmed licence and provenance', async t => {
  const bad = item('bad', { foreign_landing_url: own.replace('12345', '12346') }), good = item();
  const net = network([item('by', { license: 'by' }), bad, good], { [own]: valid, [bad.foreign_landing_url]: scope(link(by)) + link(cc0) }, { [good.url]: 'audio' });
  const result = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net });
  assert.equal(result.accepted, true, result.reason); assert.equal(result.rejections.length, 2);
  assert.equal(net.calls.includes(bad.url), false); assert.equal(fs.readFileSync(result.assetPath, 'utf8'), 'audio');
  const record = JSON.parse(fs.readFileSync(result.recordPath, 'utf8'));
  assert.equal(record.own_page_link, own); assert.equal(record.licence, 'CC0 1.0'); assert.equal(record.licence_url, cc0);
  assert.equal(record.creator, 'Artist'); assert.equal(record.title, 'Ocean'); assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
});
test('private landing, private DNS answer, and redirect to localhost fail before unsafe fetch', async t => {
  const candidates = [item('private', { foreign_landing_url: 'http://127.0.0.1/file' }), item('redirect'), item('dns', { foreign_landing_url: own.replace('12345', '12346') })];
  const net = network(candidates, { [own]: () => new Response(null, { status: 302, headers: { location: 'http://localhost/private' } }) });
  let n = 0;
  net.lookupFn = async host => host === 'freesound.org' && ++n > 1 ? [{ address: '169.254.169.254', family: 4 }] : lookupFn();
  const result = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net });
  assert.equal(result.accepted, false); assert.equal(result.rejections.length, 3);
  assert.deepEqual(net.calls.filter(u => !u.includes('api.openverse.org')), [own]);
});
test('asset URLs and redirect hops reject private and non-http targets', async t => {
  for (const target of ['http://127.0.0.1/a.mp3', 'http://[::1]/a.mp3', 'http://169.254.169.254/a.mp3', 'file:///a.mp3', 'http://2130706433/a.mp3']) {
    const candidate = item('safe', { url: target }), net = network([candidate], { [own]: valid });
    assert.equal((await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net })).accepted, false, target);
    assert.equal(net.calls.includes(target), false);
  }
  const candidate = item(), net = network([candidate], { [own]: valid }, { [candidate.url]: () => new Response(null, { status: 302, headers: { location: 'http://localhost/a.mp3' } }) });
  assert.equal((await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net })).accepted, false);
  assert.equal(net.calls.some(u => u.includes('localhost')), false);
});
test('reserved Windows filenames, separators, colons and unsupported extensions never download', async t => {
  for (const id of ['CON', 'con.jpg', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', '../evil', 'a:b', 'a\\b']) {
    const candidate = item(id), net = network([candidate], { [own]: valid });
    assert.equal((await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net })).accepted, false, id);
    assert.equal(net.calls.includes(candidate.url), false);
  }
  const net = network([item('unsafe', { filetype: '../../exe' })], { [own]: valid });
  assert.equal((await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net })).accepted, false);
});
test('redirect chains recheck DNS at every hop and enforce a hop limit', async t => {
  const candidate = item(), next = 'https://cdn.freesound.org/second.mp3';
  const redirect = url => () => new Response(null, { status: 302, headers: { location: url } });
  const net = network([candidate], { [own]: valid }, { [candidate.url]: redirect(next) });
  let n = 0;
  net.lookupFn = async host => host === 'cdn.freesound.org' && ++n > 1 ? [{ address: '10.0.0.1', family: 4 }] : lookupFn();
  const result = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net });
  assert.equal(result.accepted, false); assert.equal(net.calls.includes(next), false);
  const loop = network([candidate], { [own]: valid }, { [candidate.url]: redirect(candidate.url) });
  const rejected = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...loop });
  assert.equal(rejected.accepted, false); assert.match(rejected.rejections[0].reason, /redirect limit/);
  assert.equal(loop.calls.filter(u => u === candidate.url).length, 4);
});
test('PDM provenance uses the page-confirmed licence rather than API licence_url', async t => {
  const candidate = item('pdm', { license: 'pdm', license_url: by });
  const net = network([candidate], { [own]: scope(link(pdm)) }, { [candidate.url]: 'audio' });
  const result = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net });
  assert.equal(result.accepted, true); assert.equal(result.record.licence, 'Public Domain Mark 1.0');
  assert.equal(result.record.licence_url, pdm);
});
test('job directory must exist inside job root and contain no junctions', async t => {
  const dir = job(t), target = job(t), junction = path.join(dir, 'linked');
  fs.symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    for (const jobDir of [dir, junction, path.join(JOB_ROOT, 'missing-c2-test'), path.dirname(JOB_ROOT)]) {
      const net = network([]), result = await getOpenverseAsset({ query: 'ocean', jobDir, ...net });
      assert.equal(result.accepted, false); assert.equal(net.calls.length, 0);
    }
  } finally { fs.unlinkSync(junction); }
});
test('network errors give reasons and continue to next candidate; search errors return rejection', async t => {
  const bad = item('bad', { foreign_landing_url: own.replace('12345', '12346') }), failDownload = item('download-fails'), good = item();
  const net = network([bad, failDownload, good], { [bad.foreign_landing_url]: new Error('page offline'), [own]: valid }, { [failDownload.url]: new Error('asset offline'), [good.url]: 'audio' });
  const result = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net });
  assert.equal(result.accepted, true); assert.equal(result.rejections.length, 2); assert.match(result.rejections[0].reason, /offline/);
  assert.equal(net.calls.includes(bad.url), false);
  const fail = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), lookupFn, fetchFn: async () => { throw new Error('search offline'); } });
  assert.equal(fail.accepted, false); assert.match(fail.reason, /search offline/);
});
test('search, page and asset body streams have deadlines and size caps', async t => {
  const stalled = () => new Response(new ReadableStream({ start() {} }));
  const huge = size => () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(size)); c.close(); } }));
  for (const stage of ['search', 'page', 'asset']) {
    for (const body of [stalled, huge(stage === 'asset' ? 25 * 1024 * 1024 + 1 : 2 * 1024 * 1024 + 1)]) {
      const candidate = item(), net = network([candidate], { [own]: stage === 'page' ? body : valid }, { [candidate.url]: stage === 'asset' ? body : 'audio' });
      if (stage === 'search') net.fetchFn = async () => body();
      const result = await getOpenverseAsset({ query: 'ocean', jobDir: job(t), ...net, timeoutMs: 150 });
      assert.equal(result.accepted, false, stage);
      assert.match(stage === 'search' ? result.reason : result.rejections[0].reason, /deadline|size limit/i);
    }
  }
});
