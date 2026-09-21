import assert from 'node:assert/strict';
import { isEnvironmentDumpCommand } from '../../.opencode/plugins/nla-shell-policy.mjs';
import { sanitizeTelemetry } from '../../.opencode/plugins/nla-telemetry.mjs';

for (const command of ['env', ' printenv', 'FOO=bar env', 'env | sort', 'export -p', 'declare -p', 'set', 'cat /proc/self/environ', 'sudo -n id', 'doas id', 'runuser -u root -- id', 'su', 'su - root', 'bash -c env', "sh -c 'printenv'"]) {
  assert.equal(isEnvironmentDumpCommand(command), true, command);
}
for (const command of ['NODE_ENV=test npm test', 'git status --short', 'npm run lint', "rg 'sudo' SECURITY.md"]) {
  assert.equal(isEnvironmentDumpCommand(command), false, command);
}
const safe = sanitizeTelemetry({ command: 'curl -H "Authorization: Bearer SECRET"', reason: 'token=SECRET rejected', nested: { output: 'private', model: 'fixture/model' } });
assert.equal(safe.command, '[OMITTED]');
assert.equal(safe.nested.output, '[OMITTED]');
assert.ok(!JSON.stringify(safe).includes('SECRET'));
assert.equal(safe.nested.model, 'fixture/model');
console.log('NLA environment-dump and telemetry redaction policies passed');
