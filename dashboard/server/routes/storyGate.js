import fs from 'node:fs';
import path from 'node:path';
import { verifyStoryPlan } from './storyVerification.js';

// The dashboard can gate only text it has before a media request. A factory
// call which generates and voices its own script has no dashboard checkpoint.
export function uncheckedFactoryStory(runId, broadcast = () => {}) {
  const verification = { status: 'not_checked', reasons: ['Script is generated inside the factory before the dashboard receives it. A factory pre-TTS checkpoint is required for verification.'] };
  broadcast('verification', { run_id: runId, verification });
  broadcast('log', { run_id: runId, source: 'STORY', message: `Story: Not checked. ${verification.reasons[0]}` });
  return verification;
}

export async function checkNarration({ script, title = '', scenes = [], contentMode = 'factual', search, draftFolder, runId, broadcast = () => {} }) {
  // Match factory script_from_text before hashing or requesting speech.
  script = typeof script === 'string' ? script.replace(/\s+/g, ' ').trim() : '';
  const plan = { title, script, scenes, contentMode, ...(contentMode === 'whatif' && { premise: title }) };
  const verification = await verifyStoryPlan(plan, { contentMode, search });
  plan.verification = verification;
  if (draftFolder) {
    fs.mkdirSync(draftFolder, { recursive: true });
    fs.writeFileSync(path.join(draftFolder, 'plan.json'), JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(draftFolder, 'verification.json'), JSON.stringify(verification, null, 2));
  }
  broadcast('verification', { run_id: runId, verification });
  const review = verification.status === 'verified' ? null : { draft_id: runId, title, status: 'awaiting_review', verification };
  if (review) {
    if (draftFolder) fs.writeFileSync(path.join(draftFolder, 'metadata.json'), JSON.stringify({ ...review, contentMode }, null, 2));
    broadcast('stage_change', { run_id: runId, stage: 'awaiting_review', label: 'Awaiting story review', verification });
  }
  return { plan, verification, review };
}
