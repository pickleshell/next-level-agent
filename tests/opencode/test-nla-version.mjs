import assert from 'node:assert/strict';
import fs from 'node:fs';

const release = JSON.parse(fs.readFileSync('nla-version.json', 'utf8'));
const releaseNotes = fs.readFileSync('RELEASE-NOTES.md', 'utf8');

assert.equal(release.name, 'next-level-agent');
assert.match(release.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
assert.equal(release.tag, `nla-v${release.version}`);
assert.equal(release.channel, 'alpha');
assert.equal(release.source_provenance.project, 'https://github.com/obra/superpowers');
assert.equal(release.source_provenance.base_commit, 'b36e0829c6d0140e93cfef2ca599b1b07d4a7797');
assert.ok(releaseNotes.includes(`## v${release.version}`), 'release notes must name the canonical NLA version');

console.log('NLA release-version consistency tests passed');
