import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoSecrets } from './nla-system-database.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const bounded = (value, size = 2000) => typeof value === 'string' && value.length <= size;
export const RESULT_GUIDANCE = `Return only a JSON task report: {"status":"completed|blocked|needs_context","summary":"short factual summary","artifacts":["project-relative/path"],"checks":[{"claim":"what was checked","tool_call_id":"observed tool call ID, if known"}],"remaining":[],"blockers":[]}. Report only actual work. Checks are claims until runtime evidence or independent review confirms them. Do not invent tool IDs. Do not rerun implementation just to repair the report. No secrets or raw tool output.`;

export function parseTaskReport(output, directory, observed = new Map()) {
  if (typeof output !== 'string' || output.length > 20000) throw new Error('Task report exceeds the bounded report size');
  let report;
  try { report = JSON.parse(output); } catch { throw new Error('Task report must be JSON'); }
  if (!report || !['completed','blocked','needs_context'].includes(report.status) || !bounded(report.summary) || !report.summary.trim()) throw new Error('Invalid task report status/summary');
  const keys = ['status','summary','artifacts','checks','remaining','blockers'];
  if (Object.keys(report).some(key => !keys.includes(key))) throw new Error('Unknown task report field');
  for (const key of ['artifacts','checks','remaining','blockers']) if (!Array.isArray(report[key]) || report[key].length > 40) throw new Error('Invalid task report arrays');
  for (const item of [...report.remaining, ...report.blockers]) if (!bounded(item, 1000)) throw new Error('Invalid task report item');
  if (report.status === 'completed' && (report.remaining.length || report.blockers.length)) throw new Error('Completed task cannot have remaining work/blockers');
  assertNoSecrets(report, 'Task report');
  const root = fs.realpathSync(directory);
  const artifacts = report.artifacts.map(file => {
    if (!bounded(file, 1000) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Artifact must be project-relative');
    const full = fs.realpathSync(path.resolve(root, file));
    if (!full.startsWith(root + path.sep) || !fs.statSync(full).isFile()) throw new Error('Artifact is not a project file');
    return { path: file, evidence: 'existence_observed' };
  });
  const checks = report.checks.map(check => {
    if (!check || !bounded(check.claim, 1000) || Object.keys(check).some(key => !['claim','tool_call_id'].includes(key)) || check.tool_call_id !== undefined && !bounded(check.tool_call_id, 160)) throw new Error('Invalid check claim');
    const observation = observed.get(check.tool_call_id);
    return { ...check, evidence: observation?.status === 'completed' ? 'tool_completed_not_semantic_verification' : 'reported_only' };
  });
  return { ...report, artifacts, checks };
}

// Bounded content fingerprint, including dirty/untracked source, not merely
// HEAD. Unknown/oversized/non-Git repositories are never declared verified.
export function repositoryRevision(directory) {
  try {
    const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const root = fs.realpathSync(git(['rev-parse','--show-toplevel']).trim());
    const digest = createHash('sha256').update(git(['rev-parse','HEAD'])).update(git(['diff','--cached','--raw']));
    const files = [...new Set(git(['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))].sort();
    if (files.length > 10000) return null;
    let bytes = 0;
    for (const file of files) {
      // Runtime logs/cache are not part of the reviewed code snapshot.
      if (['.opencode/agent-run.log','.opencode/nla-role-capabilities.json'].includes(file)) continue;
      const full = path.resolve(root, file);
      if (!full.startsWith(root + path.sep)) return null;
      digest.update(file + '\0');
      let stat;
      try { stat = fs.lstatSync(full); } catch (error) { if (error.code === 'ENOENT') { digest.update('deleted'); continue; } throw error; }
      digest.update(String(stat.mode));
      if (stat.isSymbolicLink()) { digest.update(fs.readlinkSync(full)); continue; }
      if (!stat.isFile() || (bytes += stat.size) > 32 * 1024 * 1024) return null;
      digest.update(fs.readFileSync(full));
    }
    return digest.digest('hex');
  } catch { return null; }
}

export function createProgressMonitor() {
  const seen = new Set(), repeated = new Map(), observations = new Map();
  const started = new Set(), pendingMutations = new Set();
  let failedMutation = false;
  const messagesWithTools = new Set();
  let advisory = null;
  return {
    observations, messagesWithTools,
    get advisory() { return advisory; },
    get uncertainEffects() { return failedMutation || pendingMutations.size > 0; },
    resetAdvisory() { advisory = null; repeated.clear(); },
    observe(part) {
      if (part.type !== 'tool') return null;
      if (part.messageID) messagesWithTools.add(part.messageID);
      const callID = part.callID || part.id;
      const state = part.state || {};
      const toolName = /^[\w.-]{1,100}$/.test(part.tool || '') ? part.tool : 'unknown';
      const mutating = !['read','glob','grep','webfetch','skill','nla_status','nla_models','nla_report'].includes(toolName);
      if (!callID || seen.has(callID)) return null;
      if (['pending','running'].includes(state.status)) {
        if (started.has(callID)) return null;
        started.add(callID);
        if (mutating) pendingMutations.add(callID);
        return { callID, tool: toolName, status: 'running', repeat_count: 0, suspected_loop: false };
      }
      if (!['completed','error'].includes(state.status)) return null;
      started.delete(callID); pendingMutations.delete(callID);
      if (mutating && state.status === 'error' && !/unavailable tool/i.test(state.error || '')) failedMutation = true;
      seen.add(callID);
      observations.set(callID, { status: state.status, tool: part.tool });
      // Arguments/output are fingerprinted in memory only, never persisted.
      const encoded = JSON.stringify([toolName, state.input || {}, state.output || state.error || '']);
      let count = 0;
      if (encoded.length <= 256000) {
        const fingerprint = hash(encoded);
        count = (repeated.get(fingerprint) || 0) + 1;
        repeated.set(fingerprint, count);
        if (repeated.size > 256) repeated.delete(repeated.keys().next().value);
      }
      if (count === 3) advisory = 'Repeated identical tool calls returned the same result. Check whether this advances the task. Change the approach or return a blocker for Supervisor; do not claim failure merely because work is slow.';
      // Bound working memory; the durable event journal remains authoritative.
      if (seen.size > 2048) { seen.delete(seen.values().next().value); observations.delete(observations.keys().next().value); }
      return { callID, messageID: part.messageID, tool: toolName, status: state.status, repeat_count: count, suspected_loop: count === 3, review_needed: count === 6 };
    },
  };
}
