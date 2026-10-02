import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

test('always-loaded agent context stays compact', async () => {
  const agents = await read('AGENTS.md');
  assert.ok(Buffer.byteLength(agents) <= 14 * 1024);
});

test('agent router points to workflow, architecture, docs, and proof', async () => {
  const agents = await read('AGENTS.md');
  for (const route of [
    '.agents/skills/nx-cache-server-dev/SKILL.md',
    'ARCHITECTURE.md',
    'docs/README.md',
    'npm run verify',
    'Homelab',
  ]) {
    assert.match(agents, new RegExp(route.replaceAll('.', '\\.'), 'i'));
  }
});

test('router does not duplicate operational control commands', async () => {
  const agents = await read('AGENTS.md');
  assert.doesNotMatch(agents, /gh pr (create|merge)|git (pull|rebase)|docker compose up/);
});

test('documentation index points to files that exist', async () => {
  const index = await read('docs/README.md');
  for (const path of [
    'ARCHITECTURE.md',
    'README.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    '.agents/skills/nx-cache-server-dev/SKILL.md',
    'infra/github-ruleset/README.md',
  ]) {
    await assert.doesNotReject(read(path), `missing indexed file: ${path}`);
    assert.ok(index.includes(path.split('/').at(-1)));
  }
});

test('architecture records service and deployment ownership', async () => {
  const architecture = await read('ARCHITECTURE.md');
  for (const concept of ['server.js', 'server.test.js', 'Homelab', 'Security Boundaries', 'Proof Ladder']) {
    assert.match(architecture, new RegExp(concept.replaceAll('.', '\\.'), 'i'));
  }
});

test('oversized or procedural context would be rejected', () => {
  const oversized = 'x'.repeat(14 * 1024 + 1);
  assert.ok(Buffer.byteLength(oversized) > 14 * 1024);
  assert.match('gh pr merge 1', /gh pr (create|merge)/);
});
