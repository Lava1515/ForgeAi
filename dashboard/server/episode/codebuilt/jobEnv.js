// CB6: the job environment is built from nothing. Nothing is inherited from the dashboard process,
// so no .env value, token or API key can reach agent-written code through process.env.
const BASE_PATH = '/usr/local/bin:/usr/bin:/bin';
// Extra keys must be on this list. Anything secret-shaped is never on it.
export const ALLOWED_EXTRA_ENV = Object.freeze(['LANG', 'LC_ALL', 'TZ']);

export function buildJobEnv({ jobDir, jobId, extra = {} }) {
  if (typeof jobDir !== 'string' || !jobDir.startsWith('/')) throw new Error('jobEnv: jobDir must be the absolute in-container job path');
  const env = {
    PATH: BASE_PATH,
    HOME: `${jobDir}/home`,
    TEMP: `${jobDir}/tmp`,
    TMP: `${jobDir}/tmp`,
    TMPDIR: `${jobDir}/tmp`,
    FORGEAI_TEST_TMP: `${jobDir}/tmp`,
    FORGEAI_JOB_ID: String(jobId),
    FORGEAI_JOB_DIR: jobDir,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    LANG: 'C.UTF-8',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (!ALLOWED_EXTRA_ENV.includes(k)) throw new Error(`env key not allowed in a job: ${k}`);
    if (typeof v !== 'string' || v.length > 200 || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(`env value for ${k} is not a short printable string`);
    env[k] = v;
  }
  return env;
}
