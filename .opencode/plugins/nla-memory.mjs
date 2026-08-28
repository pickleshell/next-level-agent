import fs from 'fs';
import os from 'os';
import path from 'path';

export const LEDGER_KEYS = [
  'goal', 'tier', 'workflow_stage', 'acceptance_criteria', 'approved_decisions',
  'completed_tasks', 'active_task', 'changed_files', 'verification', 'blockers',
  'pending_gate', 'next_step',
];

const SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|private[_-]?key|recovery[_-]?code)\s*[:=]\s*\S+/i;

export function memoryRoot(homeDir = os.homedir(), env = process.env) {
  const configured = env.NLA_MEMORY_DIR && env.NLA_MEMORY_DIR.trim();
  return path.resolve(configured || path.join(homeDir, '.local', 'share', 'nla'));
}

export function notebookRoot(homeDir = os.homedir(), env = process.env) {
  const configured = env.ASSISTANT_NOTEBOOK_DIR && env.ASSISTANT_NOTEBOOK_DIR.trim();
  return path.resolve(configured || path.join(memoryRoot(homeDir, env), 'assistant-notebook'));
}

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

export function atomicWrite(file, content) {
  ensurePrivateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function safeSessionID(sessionID) {
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(sessionID || '')) throw new Error('Invalid NLA session identifier');
  return sessionID;
}

export function normalizeLedger(input, sessionID, directory) {
  const source = input && typeof input === 'object' ? input : {};
  const state = {
    version: 1,
    session_id: safeSessionID(sessionID),
    directory: path.resolve(directory),
    updated_at: new Date().toISOString(),
  };
  for (const key of LEDGER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) state[key] = source[key];
  }
  state.tier = Number.isInteger(state.tier) && state.tier >= 0 && state.tier <= 3 ? state.tier : null;
  for (const key of ['acceptance_criteria', 'approved_decisions', 'completed_tasks', 'changed_files', 'verification', 'blockers']) {
    state[key] = Array.isArray(state[key]) ? state[key].slice(0, 100) : [];
  }
  for (const key of ['goal', 'workflow_stage', 'pending_gate', 'next_step']) {
    state[key] = typeof state[key] === 'string' ? state[key].slice(0, 8000) : null;
  }
  state.active_task = state.active_task && typeof state.active_task === 'object' && !Array.isArray(state.active_task) ? state.active_task : null;
  const serialized = JSON.stringify(state);
  if (serialized.length > 128000) throw new Error('NLA ledger exceeds 128 KB');
  if (SECRET_PATTERN.test(serialized)) throw new Error('NLA ledger appears to contain a secret');
  return state;
}

export function ledgerPath(root, sessionID) {
  return path.join(root, 'sessions', `${safeSessionID(sessionID)}.json`);
}

export function saveLedger(root, ledger) {
  const file = ledgerPath(root, ledger.session_id);
  atomicWrite(file, JSON.stringify(ledger, null, 2) + '\n');
  return file;
}

export function loadLedger(root, sessionID) {
  const file = ledgerPath(root, sessionID);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function parseLedgerJSON(text, sessionID, directory) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('snapshot must be valid JSON'); }
  return normalizeLedger(parsed, sessionID, directory);
}

export function notebookPageName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120 || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('Invalid notebook page name');
  }
  return name.endsWith('.md') ? name : `${name}.md`;
}

export function initializeNotebook(root) {
  ensurePrivateDir(root);
  const contents = path.join(root, 'Assistant Notebook - Contents.md');
  const protocol = path.join(root, 'Notebook Protocol.md');
  if (!fs.existsSync(contents)) atomicWrite(contents, '# Assistant Notebook - Contents\n\n| Subject | Page | Status |\n| --- | --- | --- |\n| NLA system | NLA.md | Active |\n');
  if (!fs.existsSync(protocol)) atomicWrite(protocol, '# Notebook Protocol\n\nThe active conversation and verified source artifacts are primary. This notebook is compact secondary memory and a retrieval index. Read it once on substantive entry or after context loss. Update only durable decisions, verified status, artifact references, blockers, and next steps. Never store secrets or complete transcripts.\n');
  const nla = path.join(root, 'NLA.md');
  if (!fs.existsSync(nla)) atomicWrite(nla, '# NLA\n\n## Status\n\nNotebook initialized.\n\n## Decisions\n\n- Primary NLA exclusively owns notebook reads and writes.\n\n## Next step\n\nUse this page for durable NLA project memory.\n');
  return { contents, protocol, nla };
}

export function readNotebook(root, page) {
  initializeNotebook(root);
  const contents = fs.readFileSync(path.join(root, 'Assistant Notebook - Contents.md'), 'utf8');
  if (!page) return { contents, page: null, content: null };
  const filename = notebookPageName(page);
  const file = path.join(root, filename);
  return { contents, page: filename, content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
}

export function writeNotebookPage(root, page, content) {
  initializeNotebook(root);
  const filename = notebookPageName(page);
  const text = String(content || '').trim();
  if (!text || text.length > 64000) throw new Error('Notebook page must contain 1-64000 characters');
  if (SECRET_PATTERN.test(text)) throw new Error('Notebook page appears to contain a secret');
  atomicWrite(path.join(root, filename), text + '\n');
  return filename;
}

export function contextTokens(info) {
  const tokens = info && info.tokens;
  if (!tokens) return 0;
  return Number(tokens.input || 0) + Number(tokens.cache && tokens.cache.read || 0);
}

export function thresholdState(tokens, soft, hard) {
  if (tokens >= hard) return 'hard';
  if (tokens >= soft) return 'soft';
  return 'normal';
}

export function restorePacket(ledger) {
  return `<NLA_RESTORE_PACKET>\n${JSON.stringify(ledger, null, 2)}\n</NLA_RESTORE_PACKET>\nResume from next_step. Current verified evidence and explicit user instructions override this checkpoint. Consult Assistant Notebook only if durable context is missing.`;
}
