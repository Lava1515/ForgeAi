// codex · gpt-6.1-sol · 2026-11-19 15:11 +02:00: no commands in the file protocol; the host owns every render option.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { authorError } from './authorCall.js';
import { overlayWindows } from './previewFrames.js';

export const SESSION_TOOLS = ['Read','Edit','Write'];
export function sessionArgv(model, id, resume = true) {
 if (!['sonnet','opus'].includes(model)) throw authorError('author_model_unavailable');
 if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw authorError('author_receipt');
 return ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--model',model,
  '--tools',SESSION_TOOLS.join(','),'--allowedTools','Read,Edit(./build.py),Edit(./overlay.json),Edit(./render.request.json)',
  '--permission-mode','dontAsk','--disable-slash-commands','--strict-mcp-config','--safe-mode','--restricted',resume?'--resume':'--session-id',id];
}
const inside=(root,file)=>{const rel=path.relative(root,file);return rel && rel!=='..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);};
export function createAuthorSession({stageDir,attemptDir}) {
 const stage=fs.realpathSync(stageDir), attempt=fs.realpathSync(attemptDir);
 if (stage!==attempt && !inside(stage,attempt)) throw authorError('author_state_outside_code');
 const cwd=path.join(attempt,'workspace'); fs.mkdirSync(cwd);
 return {id:crypto.randomUUID(),cwd,started:false};
}
export function sessionPath(session, name) {
 // Check ancestors too: never follow junctions, symlinks, hardlinks, ADS or UNC paths for the author.
 if(typeof name!=='string'|| !/^(?:build\.py|overlay\.json|render\.request\.json|findings\.json|sheet-[01]\.jpg)$/.test(name)) throw authorError('author_state_outside_code');
 const cwd=fs.realpathSync(session.cwd);
 if(cwd!==path.resolve(session.cwd)||fs.lstatSync(session.cwd).isSymbolicLink())throw authorError('author_state_outside_code');
 const file=path.join(cwd,name);
 if(fs.existsSync(file)) {const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>20*1024*1024)throw authorError('author_state_outside_code');}
 return file;
}
export function consumePreviewRequest(session) {
 const file=sessionPath(session,'render.request.json');let request;
 try{request=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw authorError('author_reply');}
 if(!request || Object.keys(request).length!==1 || request.action!=='preview')throw authorError('author_reply');
 fs.unlinkSync(file);
}
export function readSessionPair(session) {
 return {buildScript:fs.readFileSync(sessionPath(session,'build.py'),'utf8'),overlaySpec:JSON.parse(fs.readFileSync(sessionPath(session,'overlay.json'),'utf8'))};
}
export function smallSessionFrames(input, frames) {
 const windows=[...input.shotStarts.map((from,i)=>({from,to:input.shotStarts[i+1]??input.nframes/30})),...overlayWindows(input.overlaySpec)];
 const covers=items=>windows.every(w=>items.some(f=>f/30>=w.from && f/30<w.to));
 const kept=[...frames];
 // B3 bug 2026-11-19 (last test video, 12 shots, 24 base frames): the base pick already filled its 24 and left an overlay window without a frame, so the cover could never be reached. Give every uncovered window its middle even frame first, then prune.
 for(const w of windows) {
  if(kept.some(f=>f/30>=w.from && f/30<w.to))continue;
  const first=Math.ceil(w.from*30),last=Math.ceil(w.to*30)-1;let f=Math.round(((w.from+w.to)/2)*30);f-=f%2;
  if(f<first)f+=2;if(f>last)f-=2;
  if(f>=first && f<=last && f>=0 && f<input.nframes)kept.push(f);
 }
 kept.sort((a,b)=>a-b);
 for(let i=kept.length-2;i>0;i--) {const next=kept.filter((_,n)=>n!==i);if(covers(next))kept.splice(i,1);}
 // The cap follows the windows (an irreducible cover has at most one frame per window plus the two ends) and never exceeds 24.
 if(kept.length>Math.min(24,Math.max(12,windows.length+2))||!covers(kept))throw authorError('author_reply');
 return kept;
}
