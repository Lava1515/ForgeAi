import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getOpenverseAsset,
  verifyOpenverseItem,
  evaluatePageLicense,
} from '../episode/codebuilt/openverse.js';

test('Openverse licence gate: non-CC0/PD and page-unconfirmed items are strictly rejected', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgeai-openverse-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup in tmp
    }
  });

  // Mock responses for testing
  const mockOpenverseApiResponse = {
    results: [
      {
        id: 'item-cc-by',
        title: 'Attribution Only Photo',
        license: 'by',
        license_version: '4.0',
        foreign_landing_url: 'https://example.com/photos/item-cc-by',
        url: 'https://example.com/files/item-cc-by.jpg',
        creator: 'Artist A',
      },
      {
        id: 'item-fake-cc0',
        title: 'Tagged CC0 but Page specifies CC-BY',
        license: 'cc0',
        license_version: '1.0',
        foreign_landing_url: 'https://example.com/photos/item-fake-cc0',
        url: 'https://example.com/files/item-fake-cc0.jpg',
        creator: 'Artist B',
      },
      {
        id: 'item-unconfirmed',
        title: 'Tagged CC0 but Page has no license statement',
        license: 'cc0',
        license_version: '1.0',
        foreign_landing_url: 'https://example.com/photos/item-unconfirmed',
        url: 'https://example.com/files/item-unconfirmed.jpg',
        creator: 'Artist C',
      },
      {
        id: 'item-valid-cc0',
        title: 'Genuine CC0 Ocean Sound',
        license: 'cc0',
        license_version: '1.0',
        foreign_landing_url: 'https://freesound.org/people/valid/sounds/12345',
        url: 'https://cdn.freesound.org/previews/valid.mp3',
        creator: 'Sound Designer',
      },
    ],
  };

  const mockLandingPages = {
    'https://example.com/photos/item-cc-by': `
      <html>
        <body>
          <h1>Attribution Only Photo</h1>
          <p>License: <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution (CC BY 4.0)</a></p>
        </body>
      </html>
    `,
    'https://example.com/photos/item-fake-cc0': `
      <html>
        <body>
          <h1>Tagged CC0 but Page specifies CC-BY</h1>
          <p>This work is licensed under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC-BY-SA 4.0</a>. All rights reserved.</p>
        </body>
      </html>
    `,
    'https://example.com/photos/item-unconfirmed': `
      <html>
        <body>
          <h1>Tagged CC0 but Page has no license statement</h1>
          <p>Some random blog post with no license details or links.</p>
        </body>
      </html>
    `,
    'https://freesound.org/people/valid/sounds/12345': `
      <html>
        <body>
          <h1>Genuine CC0 Ocean Sound</h1>
          <div id="sound_license">
            <a href="https://creativecommons.org/publicdomain/zero/1.0/">Creative Commons 0</a>
          </div>
        </body>
      </html>
    `,
  };

  const mockFetch = async (url) => {
    if (url.includes('api.openverse.org')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => mockOpenverseApiResponse,
      };
    }

    if (mockLandingPages[url]) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => mockLandingPages[url],
      };
    }

    if (url.endsWith('.mp3') || url.endsWith('.jpg')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
      };
    }

    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '404 Not Found',
    };
  };

  // 1. Direct unit verification on non-CC0/PD item:
  const checkCcBy = await verifyOpenverseItem(mockOpenverseApiResponse.results[0], { fetchFn: mockFetch });
  assert.equal(checkCcBy.ok, false, 'Item with API tag "by" must be rejected');
  assert.match(checkCcBy.reason, /not CC0 or PDM/);

  // 2. Direct unit verification on item with CC0 API tag but non-CC0 page:
  const checkFakeCc0 = await verifyOpenverseItem(mockOpenverseApiResponse.results[1], { fetchFn: mockFetch });
  assert.equal(checkFakeCc0.ok, false, 'Item with conflicting page license must be rejected');
  assert.match(checkFakeCc0.reason, /conflicting/i);

  // 3. Direct unit verification on item with CC0 API tag but unconfirmed page:
  const checkUnconfirmed = await verifyOpenverseItem(mockOpenverseApiResponse.results[2], { fetchFn: mockFetch });
  assert.equal(checkUnconfirmed.ok, false, 'Item with unconfirmed page license must be rejected');
  assert.match(checkUnconfirmed.reason, /does not confirm CC0/i);

  // 4. Direct unit verification on genuine CC0 item:
  const checkValid = await verifyOpenverseItem(mockOpenverseApiResponse.results[3], { fetchFn: mockFetch });
  assert.equal(checkValid.ok, true, 'Genuine CC0 item must be accepted');
  assert.equal(checkValid.license, 'CC0 1.0');

  // 5. End-to-end getOpenverseAsset: proves candidates 0, 1, 2 are rejected and candidate 3 is accepted and saved
  const result = await getOpenverseAsset({
    query: 'ocean waves',
    mediaType: 'audio',
    jobDir: tmpDir,
    destSubdir: 'assets',
    fetchFn: mockFetch,
  });

  assert.equal(result.ok, true, 'getOpenverseAsset should succeed on valid candidate');
  assert.equal(result.accepted, true);
  assert.equal(result.item.id, 'item-valid-cc0');
  assert.equal(result.rejections.length, 3, 'First three candidates should be recorded as rejections');
  assert.equal(result.rejections[0].id, 'item-cc-by');
  assert.equal(result.rejections[1].id, 'item-fake-cc0');
  assert.equal(result.rejections[2].id, 'item-unconfirmed');

  // Verify downloaded asset and license record file exist inside job folder
  assert.equal(fs.existsSync(result.assetPath), true, 'Asset file must exist on disk');
  assert.equal(fs.existsSync(result.recordPath), true, 'License record file must exist on disk');

  const recordContent = JSON.parse(fs.readFileSync(result.recordPath, 'utf-8'));
  assert.equal(recordContent.id, 'openverse-item-valid-cc0');
  assert.equal(recordContent.licence, 'CC0 1.0');
  assert.equal(recordContent.creator, 'Sound Designer');
  assert.equal(recordContent.own_page_link, 'https://freesound.org/people/valid/sounds/12345');
  assert.equal(typeof recordContent.date, 'string');
});
