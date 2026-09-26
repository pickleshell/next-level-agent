// Existing runtime fixtures exercise workers with a deterministic approving
// Supervisor. Admission failure/security tests import the production plugin
// directly. This mocks the provider response, never the admission gate.
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { NextLevelAgentPlugin as productionPlugin } from '../../.opencode/plugins/next-level-agent.js';
import { ADMISSION_TITLE, ADMISSION_PREFIX } from '../../.opencode/plugins/nla-task-admission.mjs';
export * from '../../.opencode/plugins/next-level-agent.js';

export function admissionReply(text) {
  if (!text.startsWith(ADMISSION_PREFIX)) return null;
  const { packet_hash } = JSON.parse(text.split('\n')[1]);
  return JSON.stringify({ verdict: 'approve', packet_hash, reason: 'Deterministic test packet accepted', issues: [] });
}

export async function NextLevelAgentPlugin(options) {
  const original = options.client.session || {};
  const admissions = new Set();
  const session = { ...original,
    create: async request => {
      if (request.body?.title !== ADMISSION_TITLE) return original.create(request);
      const id = `admission_${randomUUID()}`; admissions.add(id);
      return { data: { id } };
    },
    prompt: async request => {
      if (!admissions.has(request.path.id)) return original.prompt(request);
      assert.equal(request.body.agent, 'supervisor');
      assert.ok(Object.values(request.body.tools || {}).every(v => !v), 'preflight is tool-free');
      const text = admissionReply(request.body.parts[0].text);
      assert.ok(text, 'exact preflight packet supplied');
      return { data: { parts: [{ type: 'text', text }] } };
    },
  };
  return productionPlugin({ ...options, client: { ...options.client, session } });
}
