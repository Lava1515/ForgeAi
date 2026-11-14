import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FORGEAI_ROOT || (fs.existsSync('/forgeai') ? '/forgeai' : path.resolve(__dirname, '../../../'));

export const QWEN_MODEL_ID = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
export const QWEN_SPEAKERS = Object.freeze([
  'aiden',
  'dylan',
  'eric',
  'ono_anna',
  'ryan',
  'serena',
  'sohee',
  'uncle_fu',
  'vivian',
]);
export const DEFAULT_SPEAKER = 'ryan';

export const SPEAKER_PROFILES = Object.freeze({
  ryan: {
    id: 'ryan',
    name: 'Ryan',
    gender: 'male',
    accent: 'Native English',
    traits: ['dramatic', 'rhythmic', 'authoritative'],
    bestFor: ['mysteries', 'dark history', 'hooks'],
    description: 'Dramatic male, native English, strong rhythmic drive: mysteries, dark history, hooks.',
    isDefault: true,
  },
  aiden: {
    id: 'aiden',
    name: 'Aiden',
    gender: 'male',
    accent: 'Native English',
    traits: ['friendly', 'clear', 'sunny'],
    bestFor: ['science', 'explainers'],
    description: 'Friendly male, native English, clear and sunny: science, explainers.',
    isDefault: false,
  },
  vivian: {
    id: 'vivian',
    name: 'Vivian',
    gender: 'female',
    accent: 'Chinese accent',
    traits: ['bright', 'slightly edgy', 'emotional'],
    bestFor: ['true stories', 'emotional'],
    description: 'Bright, slightly edgy young female, Chinese accent: true stories, emotional.',
    isDefault: false,
  },
  serena: {
    id: 'serena',
    name: 'Serena',
    gender: 'female',
    accent: 'Chinese accent',
    traits: ['warm', 'gentle', 'calm'],
    bestFor: ['heartfelt', 'calm stories'],
    description: 'Warm, gentle young female, Chinese accent: heartfelt, calm stories.',
    isDefault: false,
  },
  uncle_fu: {
    id: 'uncle_fu',
    name: 'Uncle Fu',
    gender: 'male',
    accent: 'Chinese accent',
    traits: ['seasoned low', 'mellow', 'slow pace'],
    bestFor: ['history', 'legends', 'slow storytelling'],
    description: 'Seasoned low, mellow male, Chinese accent: history, legends, slow storytelling.',
    isDefault: false,
  },
  dylan: {
    id: 'dylan',
    name: 'Dylan',
    gender: 'male',
    accent: 'Chinese accent',
    traits: ['clear', 'natural', 'conversational'],
    bestFor: ['everyday stories', 'facts'],
    description: 'Clear, natural young male, Chinese accent: everyday stories, facts.',
    isDefault: false,
  },
  eric: {
    id: 'eric',
    name: 'Eric',
    gender: 'male',
    accent: 'Chinese accent',
    traits: ['lively', 'slightly husky', 'energetic'],
    bestFor: ['energetic', 'fun facts'],
    description: 'Lively, slightly husky male, Chinese accent: energetic, fun facts.',
    isDefault: false,
  },
  ono_anna: {
    id: 'ono_anna',
    name: 'Ono Anna',
    gender: 'female',
    accent: 'Japanese accent',
    traits: ['light', 'playful', 'quirky'],
    bestFor: ['quirky', 'cute', 'lighthearted'],
    description: 'Light, playful female, Japanese accent: quirky, cute, lighthearted.',
    isDefault: false,
  },
  sohee: {
    id: 'sohee',
    name: 'Sohee',
    gender: 'female',
    accent: 'Korean accent',
    traits: ['warm', 'rich emotion', 'expressive'],
    bestFor: ['emotional', 'dramatic stories'],
    description: 'Warm female with rich emotion, Korean accent: emotional, dramatic stories.',
    isDefault: false,
  },
});

export function resolveVoiceSamplesDir() {
  if (process.env.FORGEAI_VOICE_SAMPLES_DIR && fs.existsSync(process.env.FORGEAI_VOICE_SAMPLES_DIR)) {
    return process.env.FORGEAI_VOICE_SAMPLES_DIR;
  }
  const repoCandidate = path.join(REPO_ROOT, 'output/temp/voice-samples');
  if (fs.existsSync(repoCandidate)) return repoCandidate;
  const mainCandidate = path.resolve('C:/code/ForgeAi/output/temp/voice-samples');
  if (fs.existsSync(mainCandidate)) return mainCandidate;
  return repoCandidate;
}

export function readManifest(samplesDir = resolveVoiceSamplesDir()) {
  try {
    if (!fs.existsSync(samplesDir)) return null;
    const files = fs.readdirSync(samplesDir);
    const manifestFile = files.find((f) => f.startsWith('manifest') && f.endsWith('.json'));
    if (manifestFile) {
      const fullPath = path.join(samplesDir, manifestFile);
      const raw = fs.readFileSync(fullPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch {
    // If unreadable or missing, return null
  }
  return null;
}

function regularSamplePath(file, samplesDir) {
  try {
    const root = path.resolve(samplesDir);
    const relative = path.relative(root, path.resolve(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    let current = root;
    for (const part of ['', ...relative.split(path.sep)]) {
      if (part) current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return null;
    }
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.nlink === 1 ? file : null;
  } catch { return null; }
}

export function findSampleFilePath(id, samplesDir = resolveVoiceSamplesDir()) {
  const cleanId = String(id || '').trim().toLowerCase();
  if (!QWEN_SPEAKERS.includes(cleanId)) return null;

  // Try direct <id>.wav
  const flat = path.join(samplesDir, `${cleanId}.wav`);
  if (regularSamplePath(flat, samplesDir)) return flat;

  // Try nested <id>/voice.wav
  const nested = path.join(samplesDir, cleanId, 'voice.wav');
  if (regularSamplePath(nested, samplesDir)) return nested;

  return null;
}

export function hasSampleFile(id, samplesDir = resolveVoiceSamplesDir()) {
  return Boolean(findSampleFilePath(id, samplesDir));
}

export function getVoiceList(samplesDir = resolveVoiceSamplesDir()) {
  const manifest = readManifest(samplesDir);
  const sampleMap = new Map();
  if (manifest?.samples && Array.isArray(manifest.samples)) {
    for (const sample of manifest.samples) {
      if (sample.voice) {
        sampleMap.set(sample.voice.toLowerCase(), sample);
      }
    }
  }

  const defaultScript = 'Imagine standing beside the ocean as the world becomes quiet. A small light moves across the horizon, then disappears behind the clouds. You take one careful step forward. Somewhere in the distance, a familiar voice says that the journey is only beginning.';

  const voices = QWEN_SPEAKERS.map((id) => {
    const profile = SPEAKER_PROFILES[id] || {
      id,
      name: id,
      gender: 'unknown',
      accent: 'English',
      traits: [],
      bestFor: [],
      description: '',
      isDefault: id === DEFAULT_SPEAKER,
    };
    const sample = sampleMap.get(id);
    const wavExists = hasSampleFile(id, samplesDir);

    return {
      ...profile,
      hasSample: wavExists,
      sampleUrl: `/api/voices/${id}/sample`,
      seconds: typeof sample?.seconds === 'number' ? Number(sample.seconds.toFixed(2)) : null,
      sampleRate: sample?.rate || 24000,
      wallSeconds: typeof sample?.wall_seconds === 'number' ? Number(sample.wall_seconds.toFixed(2)) : null,
    };
  });

  return {
    model: manifest?.model || QWEN_MODEL_ID,
    licence: 'Apache-2.0',
    licenceNote: 'Commercial monetization allowed without royalties. Recorded in licenses/register.json.',
    script: manifest?.script || defaultScript,
    totalVoices: voices.length,
    defaultVoice: DEFAULT_SPEAKER,
    voices,
  };
}

export function getVoicesHandler(req, res) {
  try {
    const data = getVoiceList();
    return res.json(data);
  } catch (err) {
    console.error('[ForgeAI] Failed to get voices:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export function getSingleVoiceHandler(req, res) {
  const { id } = req.params;
  const cleanId = String(id || '').trim().toLowerCase();
  if (!QWEN_SPEAKERS.includes(cleanId)) {
    return res.status(404).json({ error: `Unknown speaker: ${id}` });
  }
  const list = getVoiceList();
  const voice = list.voices.find((v) => v.id === cleanId);
  if (!voice) {
    return res.status(404).json({ error: `Voice not found: ${cleanId}` });
  }
  return res.json({
    ...voice,
    model: list.model,
    licence: list.licence,
    script: list.script,
  });
}

export function getVoiceSampleHandler(req, res) {
  const { id } = req.params;
  const cleanId = String(id || '').trim().toLowerCase();
  if (!QWEN_SPEAKERS.includes(cleanId)) {
    return res.status(404).json({ error: `Unknown speaker: ${id}` });
  }

  const filePath = findSampleFilePath(cleanId);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Sample audio file not found for speaker: ${cleanId}` });
  }

  try {
    const before = fs.lstatSync(filePath);
    const fd = fs.openSync(filePath, 'r');
    let audio;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev || !regularSamplePath(filePath, resolveVoiceSamplesDir())) {
        return res.status(404).json({ error: 'Sample is unavailable.' });
      }
      audio = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    const total = audio.length;
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const suffix = match && match[1] === '';
      const start = match ? (suffix ? Math.max(0, total - Number(match[2])) : Number(match[1])) : NaN;
      const end = match ? (suffix || match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1)) : NaN;

      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (suffix && Number(match[2]) <= 0) || start >= total || end >= total || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).send('Requested range not satisfiable');
      }

      const chunksize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/wav',
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(audio.subarray(start, end + 1));
    }

    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end(audio);
  } catch (err) {
    console.error(`[ForgeAI] Failed to stream voice sample for ${cleanId}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
