import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { NlaMem0Plugin } from '../../.opencode/plugins/nla-mem0.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(repoRoot, 'opencode.json');

const output = execFileSync('opencode', ['debug', 'skill'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [path.join(repoRoot, 'skills/mem0-memory')] } }),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
  },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const jsonStart = output.indexOf('[\n');
assert.notEqual(jsonStart, -1, 'OpenCode must return its discovered skill catalog');
const skills = JSON.parse(output.slice(jsonStart));
const mem0Skill = skills.find((skill) => skill.name === 'mem0-memory');
assert.ok(mem0Skill, 'OpenCode must discover mem0-memory through the configured skills path');
assert.equal(mem0Skill.location, path.join(repoRoot, 'skills/mem0-memory/SKILL.md'));
assert.match(mem0Skill.content, /memory_search/);

const originalURL = process.env.NLA_MEM0_URL;
process.env.NLA_MEM0_URL = 'http://127.0.0.1:1';
try {
  const plugin = await NlaMem0Plugin();
  const expectedTools = [
    'memory_add', 'memory_search', 'memory_list', 'memory_get',
    'memory_update', 'memory_delete', 'memory_history',
  ];
  assert.deepEqual(Object.keys(plugin.tool).sort(), expectedTools.sort());
  for (const name of expectedTools) {
    const schema = plugin.tool[name].args;
    assert.ok(schema, `${name} must expose an argument schema`);
    assert.equal(Object.hasOwn(schema, 'user_id'), false, `${name} must not let the agent expand the server-owned namespace`);
  }
} finally {
  if (originalURL === undefined) delete process.env.NLA_MEM0_URL;
  else process.env.NLA_MEM0_URL = originalURL;
}

const config = JSON.parse(await readFile(configPath, 'utf8'));
const withoutMem0 = structuredClone(config);
withoutMem0.plugin = withoutMem0.plugin.filter((entry) => entry !== './.opencode/plugins/nla-mem0.js');
assert.equal(withoutMem0.plugin.includes('./.opencode/plugins/next-level-agent.js'), true);
assert.equal(withoutMem0.skills.paths.includes('./skills'), true);

console.log('NLA Mem0 skill discovery and optional capability tests passed');
