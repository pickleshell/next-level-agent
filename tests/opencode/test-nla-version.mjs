import assert from 'node:assert/strict';
import fs from 'node:fs';

const release = JSON.parse(fs.readFileSync('nla-version.json', 'utf8'));
const packageMetadata = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const bumpConfig = JSON.parse(fs.readFileSync('.version-bump.json', 'utf8'));
const readme = fs.readFileSync('README.md', 'utf8');
const install = fs.readFileSync('INSTALL.md', 'utf8');
const status = fs.readFileSync('docs/PROJECT_STATUS_AND_USAGE.md', 'utf8');
const releaseNotes = fs.readFileSync('RELEASE-NOTES.md', 'utf8');

assert.equal(release.name, 'next-level-agent');
assert.match(release.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
assert.equal(release.tag, `nla-v${release.version}`);
assert.equal(release.channel, 'alpha');
assert.equal(packageMetadata.version, release.upstream_base.version);
assert.equal(release.upstream_base.name, 'superpowers');
assert.equal(
  bumpConfig.files.some(({ path }) => path === 'nla-version.json'),
  false,
  'the inherited Superpowers bump script must not overwrite NLA release metadata',
);
for (const [name, text] of [['README', readme], ['install', install], ['status', status], ['release notes', releaseNotes]]) {
  assert.ok(text.includes(release.version), `${name} must name the canonical NLA version`);
  assert.ok(text.includes(release.tag), `${name} must name the canonical NLA tag`);
}

console.log('NLA release-version consistency tests passed');
