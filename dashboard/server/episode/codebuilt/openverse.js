// Lane C2: Openverse asset fetcher with strict CC0/Public Domain license gate.
// Threat model and rules: docs/codebuilt-isolation.md, CLAUDE.md rule 1 and rule 5.
//
// Rules enforced:
// 1. Licence tag in search result must be 'cc0' or 'pdm' (Public Domain Mark).
// 2. Licence must be confirmed on item's own landing page (foreign_landing_url or detail_url).
//    Anything else (CC-BY, CC-BY-SA, unknown, 'cc0' on API but different on page) is rejected.
// 3. Accepted file is downloaded strictly inside the job's own folder (inside output/agent-jobs/<job>/ only).
// 4. Record with link, licence, creator, title and date is saved next to the asset.
// 5. Anonymous API use, no keys, no paid APIs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInside, resolveJobDir } from './jobPaths.js';

export const OPENVERSE_API_BASE = 'https://api.openverse.org/v1';
export const DEFAULT_USER_AGENT = 'ForgeAi-Openverse/1.0 (+https://github.com/ForgeAi)';
export const ALLOWED_API_LICENSES = new Set(['cc0', 'pdm']);

/**
 * Searches Openverse API for CC0 / PDM media.
 * Returns an array of search result items.
 */
export async function searchOpenverse({
  query,
  mediaType = 'image',
  pageSize = 10,
  fetchFn = fetch,
  userAgent = DEFAULT_USER_AGENT,
} = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('searchOpenverse requires a non-empty query string');
  }
  const typeEndpoint = (mediaType === 'audio' || mediaType === 'sound') ? 'audio' : 'images';
  const url = `${OPENVERSE_API_BASE}/${typeEndpoint}/?q=${encodeURIComponent(query.trim())}&license=cc0,pdm&page_size=${pageSize}`;

  const res = await fetchFn(url, {
    headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Openverse search failed with HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

/**
 * Evaluates whether landing page content confirms CC0 or Public Domain.
 * Rejects non-CC0/PD licenses (such as CC-BY, CC-BY-SA, All Rights Reserved) or unconfirmed pages.
 */
export function evaluatePageLicense(content, { url = '' } = {}) {
  if (typeof content !== 'string' || !content.trim()) {
    return { confirmed: false, reason: 'Empty or missing landing page content' };
  }

  const isWikimedia = /commons\.wikimedia\.org/i.test(url) || /licensetpl/i.test(content);

  if (isWikimedia) {
    // Wikimedia Commons pages have footer text with CC BY-SA for the wiki site text,
    // so the item's own media license must be confirmed in the file's license template/box.
    const licTableMatch = content.match(/<table[^>]+class=[\x22'][^>]*licensetpl[^>]*[\x22'][^>]*>([\s\S]*?)<\/table>/i);
    const scope = licTableMatch ? licTableMatch[1] : content;

    const hasCc0 = /creativecommons\.org\/publicdomain\/zero/i.test(scope) ||
                   /\bCC0\b/i.test(scope) ||
                   /Creative\s+Commons\s+Zero/i.test(scope) ||
                   /Public\s+Domain\s+Dedication/i.test(scope);
    const hasPdm = /creativecommons\.org\/publicdomain\/mark/i.test(scope) ||
                   /Public\s+Domain\s+Mark/i.test(scope) ||
                   /\bNo\s+Copyright\b/i.test(scope);

    // Conflicting license inside the item's license template:
    const hasBy = /creativecommons\.org\/licenses\/by/i.test(scope) ||
                  /Creative\s+Commons\s+Attribution/i.test(scope);

    if ((hasCc0 || hasPdm) && !hasBy) {
      return { confirmed: true, license: hasCc0 ? 'CC0 1.0' : 'Public Domain Mark' };
    }
    if (hasBy) {
      return { confirmed: false, reason: 'Wikimedia file license template specifies conflicting CC-BY/Attribution, not CC0/PD' };
    }
    if (!hasCc0 && !hasPdm) {
      return { confirmed: false, reason: 'Wikimedia file license template does not confirm CC0 or Public Domain' };
    }
  }

  // Generic or other provider source (Freesound, Flickr, Met, etc.)
  const hasCc0Link = /creativecommons\.org\/publicdomain\/zero/i.test(content);
  const hasPdmLink = /creativecommons\.org\/publicdomain\/mark/i.test(content);
  const hasCc0Text = /Creative\s+Commons\s+0\b/i.test(content) ||
                     /Creative\s+Commons\s+Zero\b/i.test(content) ||
                     /\bCC0\s+1\.0\b/i.test(content) ||
                     /Public\s+Domain\s+Dedication\b/i.test(content);
  const hasPdmText = /Public\s+Domain\s+Mark\b/i.test(content) ||
                     /dedicated\s+to\s+the\s+public\s+domain\b/i.test(content) ||
                     /\bNo\s+known\s+copyright\b/i.test(content) ||
                     /\bNo\s+Copyright\b/i.test(content);

  const hasConflictingLicense = /creativecommons\.org\/licenses\/by/i.test(content) ||
                                /Creative\s+Commons\s+Attribution/i.test(content) ||
                                /All\s+Rights\s+Reserved/i.test(content) ||
                                /\bCC-BY\b/i.test(content);

  if (hasConflictingLicense && !hasCc0Link && !hasPdmLink) {
    return { confirmed: false, reason: 'Landing page contains conflicting non-CC0/PD license (CC-BY/All Rights Reserved)' };
  }

  if (hasCc0Link || hasCc0Text) {
    if (hasConflictingLicense && !hasCc0Link) {
      return { confirmed: false, reason: 'Landing page contains conflicting non-CC0 license indicators' };
    }
    return { confirmed: true, license: 'CC0 1.0' };
  }

  if (hasPdmLink || hasPdmText) {
    if (hasConflictingLicense && !hasPdmLink) {
      return { confirmed: false, reason: 'Landing page contains conflicting non-PD license indicators' };
    }
    return { confirmed: true, license: 'Public Domain Mark' };
  }

  return { confirmed: false, reason: 'Landing page does not confirm CC0 or Public Domain license' };
}

/**
 * Confirms license on the item's own page (foreign_landing_url or detail_url).
 */
export async function confirmPageLicense(landingUrl, {
  fetchFn = fetch,
  timeoutMs = 10000,
  userAgent = DEFAULT_USER_AGENT,
} = {}) {
  if (!landingUrl) {
    return { confirmed: false, reason: 'Missing landing page URL' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchFn(landingUrl, {
      headers: { 'User-Agent': userAgent, 'Accept': 'text/html,application/xhtml+xml,application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return { confirmed: false, reason: `Landing page responded with HTTP ${res.status}` };
    }

    const text = await res.text();
    return evaluatePageLicense(text, { url: landingUrl });
  } catch (err) {
    return { confirmed: false, reason: `Failed to fetch landing page: ${err.message}` };
  }
}

/**
 * Validates an item from Openverse:
 * (1) licence tag in API result is cc0 or pdm
 * (2) confirmed on item's own page
 */
export async function verifyOpenverseItem(item, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
  if (!item || typeof item !== 'object') {
    return { ok: false, reason: 'Invalid or missing item record' };
  }

  const rawLicense = (item.license || '').trim().toLowerCase();
  if (!ALLOWED_API_LICENSES.has(rawLicense)) {
    return {
      ok: false,
      reason: `Search-result licence tag "${item.license}" is not CC0 or PDM (rejected: ${rawLicense || 'missing'})`,
    };
  }

  const landingUrl = item.foreign_landing_url || item.detail_url;
  if (!landingUrl) {
    return { ok: false, reason: 'Item has no foreign_landing_url or detail_url to verify' };
  }

  const pageCheck = await confirmPageLicense(landingUrl, { fetchFn, timeoutMs });
  if (!pageCheck.confirmed) {
    return {
      ok: false,
      reason: `Licence not confirmed on item's own page (${landingUrl}): ${pageCheck.reason}`,
    };
  }

  return {
    ok: true,
    license: pageCheck.license || (rawLicense === 'cc0' ? 'CC0 1.0' : 'Public Domain Mark'),
    landingUrl,
    item,
  };
}

/**
 * Downloads and stores accepted asset and its license record inside the job directory only.
 */
export async function storeAcceptedAsset({
  item,
  jobDir,
  destSubdir = 'assets',
  filename,
  confirmedLicense,
  fetchFn = fetch,
  userAgent = DEFAULT_USER_AGENT,
}) {
  if (!jobDir) {
    throw new Error('storeAcceptedAsset requires jobDir');
  }

  const resolvedJobDir = path.resolve(jobDir);

  // Build filename
  let ext = '';
  if (item.filetype) {
    ext = `.${item.filetype.replace(/^\./, '')}`;
  } else if (item.url) {
    try {
      const urlPath = new URL(item.url).pathname;
      ext = path.extname(urlPath);
    } catch {
      ext = '';
    }
    if (!ext) {
      ext = (item.category === 'audio' || item.filetype === 'mp3') ? '.mp3' : '.jpg';
    }
  } else {
    ext = '.bin';
  }

  const cleanBase = (filename || `${item.id || 'openverse-asset'}`)
    .replace(/[^\w.-]/g, '_')
    .replace(/^_+/, '');
  const finalFilename = cleanBase.endsWith(ext) ? cleanBase : `${cleanBase}${ext}`;

  const destFolder = path.resolve(resolvedJobDir, destSubdir);
  const destPath = path.resolve(destFolder, finalFilename);

  // Fence check: must be strictly inside the job directory
  if (!isInside(resolvedJobDir, destPath)) {
    throw new Error(`Security fence violation: target asset path ${destPath} is outside job directory ${resolvedJobDir}`);
  }

  // Fetch file bytes
  const res = await fetchFn(item.url, {
    headers: { 'User-Agent': userAgent },
  });
  if (!res.ok) {
    throw new Error(`Failed to download asset from ${item.url}: HTTP ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.mkdirSync(destFolder, { recursive: true });
  fs.writeFileSync(destPath, buffer);

  // Build record
  const record = {
    id: `openverse-${item.id}`,
    title: item.title || '',
    creator: item.creator || 'Unknown',
    creator_url: item.creator_url || null,
    source: item.foreign_landing_url || item.detail_url || item.url,
    own_page_link: item.foreign_landing_url || item.detail_url || item.url,
    licence: confirmedLicense || (item.license === 'pdm' ? 'Public Domain Mark 1.0' : 'CC0 1.0'),
    licence_url: item.license_url || (item.license === 'pdm' ? 'https://creativecommons.org/publicdomain/mark/1.0/' : 'https://creativecommons.org/publicdomain/zero/1.0/'),
    date: new Date().toISOString().slice(0, 10),
    file: path.relative(resolvedJobDir, destPath).replace(/\\/g, '/'),
    file_bytes: buffer.length,
    download_url: item.url,
    attribution: item.attribution || '',
    how_checked: 'Openverse API license tag checked (CC0/PDM), confirmed on item landing page before download.',
  };

  const recordFilename = `${path.basename(destPath, path.extname(destPath))}_license.json`;
  const recordPath = path.resolve(destFolder, recordFilename);
  if (!isInside(resolvedJobDir, recordPath)) {
    throw new Error(`Security fence violation: record path ${recordPath} is outside job directory ${resolvedJobDir}`);
  }
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf-8');

  return {
    destPath,
    recordPath,
    record,
  };
}

/**
 * Main entry point: given a search phrase from the author, finds an image or ambience sound
 * on Openverse, verifies CC0/PDM on API and confirmed on item's own page, downloads to job folder,
 * and writes the license record.
 */
export async function getOpenverseAsset({
  query,
  mediaType = 'image',
  jobId,
  jobDir,
  destSubdir = 'assets',
  filename,
  destFilename,
  pageSize = 10,
  fetchFn = fetch,
  timeoutMs = 10000,
} = {}) {
  const chosenFilename = filename || destFilename;
  const resolvedJobDir = jobDir ? path.resolve(jobDir) : (jobId ? resolveJobDir(jobId) : null);
  if (!resolvedJobDir) {
    throw new Error('getOpenverseAsset requires either jobId or jobDir');
  }

  const candidates = await searchOpenverse({
    query,
    mediaType,
    pageSize,
    fetchFn,
  });

  const rejections = [];
  for (const item of candidates) {
    const verification = await verifyOpenverseItem(item, { fetchFn, timeoutMs });
    if (!verification.ok) {
      rejections.push({
        id: item.id,
        title: item.title,
        license: item.license,
        landingUrl: item.foreign_landing_url || item.detail_url,
        reason: verification.reason,
      });
      continue;
    }

    // Accepted item! Download and store inside job folder
    const stored = await storeAcceptedAsset({
      item,
      jobDir: resolvedJobDir,
      destSubdir,
      filename: chosenFilename,
      confirmedLicense: verification.license,
      fetchFn,
    });

    return {
      ok: true,
      accepted: true,
      item,
      assetPath: stored.destPath,
      recordPath: stored.recordPath,
      record: stored.record,
      rejections,
    };
  }

  return {
    ok: false,
    accepted: false,
    error: `No candidate for query "${query}" met CC0/Public Domain verification requirements`,
    checkedCount: candidates.length,
    rejections,
  };
}

// CLI entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      let query = '';
      let mediaType = 'image';
      let jobDir = '';
      let jobId = '';
      let destSubdir = 'assets';
      let filename = '';

      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--query' && args[i + 1]) query = args[++i];
        else if (args[i] === '--type' && args[i + 1]) mediaType = args[++i];
        else if (args[i] === '--job-dir' && args[i + 1]) jobDir = args[++i];
        else if (args[i] === '--job-id' && args[i + 1]) jobId = args[++i];
        else if (args[i] === '--dest' && args[i + 1]) destSubdir = args[++i];
        else if (args[i] === '--filename' && args[i + 1]) filename = args[++i];
      }

      if (!query || (!jobDir && !jobId)) {
        console.error('Usage: node openverse.js --query <phrase> [--type image|audio] [--job-dir <dir> | --job-id <id>] [--dest assets] [--filename name]');
        process.exit(1);
      }

      const result = await getOpenverseAsset({ query, mediaType, jobDir, jobId, destSubdir, filename });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(2);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}

export default getOpenverseAsset;
