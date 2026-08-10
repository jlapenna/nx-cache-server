const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const { publishEntry, parseTokenMap } = require('./server');

const WRITE_TOKEN = 'write-token';
const READ_TOKEN = 'read-token';

let cacheDir;
let child;
let logs;
let port;

beforeEach(async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-cache-server-test-'));
  logs = [];

  let output = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PORT: '0',
      CACHE_DIR: cacheDir,
      NX_CACHE_ACCESS_TOKEN: WRITE_TOKEN,
      NX_CACHE_READ_ONLY_ACCESS_TOKEN: READ_TOKEN,
      PRUNE_INTERVAL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const readLogs = (chunk) => {
    output += chunk;
    const lines = output.split('\n');
    output = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line);
      logs.push(record);
      if (record.event === 'server_started') {
        port = record.port;
        resolveReady();
      }
    }
  };
  child.stdout.on('data', readLogs);
  child.stderr.on('data', readLogs);
  child.once('exit', (code) => {
    rejectReady(new Error(`cache server exited before startup (${code})`));
  });
  await ready;
});

afterEach(async () => {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function cacheUrl(hash) {
  return `http://127.0.0.1:${port}/v1/cache/${hash}`;
}

function startPut(hash, token = WRITE_TOKEN) {
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = http.request(
    cacheUrl(hash),
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
    },
    (incoming) => {
      incoming.resume();
      incoming.once('end', () =>
        resolveResponse({ status: incoming.statusCode }),
      );
    },
  );
  request.once('error', rejectResponse);
  return { request, response };
}

async function waitForTempFiles(count) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const files = fs
      .readdirSync(cacheDir)
      .filter((file) => file.startsWith('.tmp-'));
    if (files.length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${count} temporary cache file(s)`);
}

async function waitForLog(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const record = logs.find(predicate);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for cache-server log record');
}

async function get(hash, token = WRITE_TOKEN) {
  const response = await fetch(cacheUrl(hash), {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

function runCanary(metricDir, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      [path.join(__dirname, 'canary.sh')],
      {
        env: {
          ...process.env,
          CACHE_URL: `http://127.0.0.1:${port}`,
          TEXTFILE_DIR: metricDir,
          NX_CACHE_ACCESS_TOKEN: WRITE_TOKEN,
          NX_CACHE_READ_ONLY_ACCESS_TOKEN: READ_TOKEN,
          ...envOverrides,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `canary failed (${error.message})\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

// Spawns a dedicated server instance with custom env — used by tests that
// need env vars the shared beforeEach server doesn't set (token-map mode,
// startup-validation failures). Resolves { proc, port, logs } once
// 'server_started' is observed, or rejects (with .logs and .code attached)
// if the process exits first.
function spawnServer(envOverrides) {
  return new Promise((resolve, reject) => {
    let output = '';
    const logs = [];
    const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: {
        ...process.env,
        PORT: '0',
        CACHE_DIR: cacheDir,
        PRUNE_INTERVAL_MS: '60000',
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const readLogs = (chunk) => {
      output += chunk;
      const lines = output.split('\n');
      output = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line);
        logs.push(record);
        if (record.event === 'server_started') {
          resolve({ proc, port: record.port, logs });
        }
      }
    };
    proc.stdout.on('data', readLogs);
    proc.stderr.on('data', readLogs);
    proc.once('exit', (code) => {
      reject(Object.assign(new Error(`server exited (${code})`), { logs, code }));
    });
  });
}

async function stopServer(proc) {
  proc.kill('SIGTERM');
  await new Promise((resolve) => proc.once('exit', resolve));
}

test('the live canary verifies protocol semantics and writes metrics', async () => {
  const metricDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nx-cache-canary-test-'),
  );
  try {
    const { stdout, stderr } = await runCanary(metricDir);
    assert.match(stdout, /write=200 read=200 readonly-put=403 conflict=409/);
    assert.equal(stderr, '');

    const metrics = fs.readFileSync(
      path.join(metricDir, 'nx_cache_canary.prom'),
      'utf8',
    );
    assert.match(
      metrics,
      /^node_nx_cache_canary_last_success_timestamp_seconds \d+$/m,
    );
    assert.match(metrics, /^node_nx_cache_canary_duration_seconds \d+$/m);

    await waitForLog(
      (record) =>
        record.event === 'cache_request' &&
        record.method === 'PUT' &&
        record.result === 'read_only' &&
        record.status === 403,
    );
    await waitForLog(
      (record) =>
        record.event === 'cache_request' &&
        record.method === 'PUT' &&
        record.result === 'exists' &&
        record.status === 409,
    );
  } finally {
    fs.rmSync(metricDir, { recursive: true, force: true });
  }
});

test('the live canary supports a named-token map', async () => {
  const tokensFile = path.join(cacheDir, 'canary-tokens.json');
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      writer: { role: 'write', token: 'canary-writer-token' },
      reader: { role: 'read', token: 'canary-reader-token' },
    }),
  );
  const { proc, port: mapPort } = await spawnServer({
    NX_CACHE_TOKENS_FILE: tokensFile,
  });
  const metricDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nx-cache-canary-map-test-'),
  );
  try {
    const { stdout, stderr } = await runCanary(metricDir, {
      CACHE_URL: `http://127.0.0.1:${mapPort}`,
      NX_CACHE_TOKENS_FILE: tokensFile,
    });
    assert.match(stdout, /write=200 read=200 readonly-put=403 conflict=409/);
    assert.equal(stderr, '');
  } finally {
    await stopServer(proc);
    fs.rmSync(metricDir, { recursive: true, force: true });
  }
});

test('the live canary requires a read-role entry in a named-token map', async () => {
  const tokensFile = path.join(cacheDir, 'write-only-canary-tokens.json');
  const metricDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nx-cache-canary-map-test-'),
  );
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({ writer: { role: 'write', token: 'canary-writer-token' } }),
  );
  try {
    await assert.rejects(
      runCanary(metricDir, { NX_CACHE_TOKENS_FILE: tokensFile }),
      /token map must include a read-role entry for the live canary/,
    );
  } finally {
    fs.rmSync(metricDir, { recursive: true, force: true });
  }
});

test('a read cannot observe an in-flight upload', async () => {
  const upload = startPut('read-during-write');
  upload.request.write('first-half');
  await waitForTempFiles(1);

  assert.deepEqual(await get('read-during-write'), {
    status: 404,
    body: '',
  });

  upload.request.end('-second-half');
  assert.deepEqual(await upload.response, { status: 200 });
  assert.deepEqual(await get('read-during-write'), {
    status: 200,
    body: 'first-half-second-half',
  });
  await waitForTempFiles(0);
});

test('concurrent same-hash uploads publish exactly one complete value', async () => {
  const first = startPut('concurrent');
  const second = startPut('concurrent');
  first.request.write('first-');
  second.request.write('second-');
  await waitForTempFiles(2);

  first.request.end('value');
  second.request.end('value');
  const [firstResponse, secondResponse] = await Promise.all([
    first.response,
    second.response,
  ]);

  assert.deepEqual(
    [firstResponse.status, secondResponse.status].sort(),
    [200, 409],
  );
  const winner =
    firstResponse.status === 200 ? 'first-value' : 'second-value';
  assert.deepEqual(await get('concurrent'), {
    status: 200,
    body: winner,
  });
  await waitForTempFiles(0);
});

test('an existing cache entry is immutable', async () => {
  const first = await fetch(cacheUrl('immutable'), {
    method: 'PUT',
    headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    body: 'original',
  });
  const second = await fetch(cacheUrl('immutable'), {
    method: 'PUT',
    headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    body: 'replacement',
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.deepEqual(await get('immutable'), {
    status: 200,
    body: 'original',
  });
});

test('an aborted upload is removed without publishing', async () => {
  const upload = startPut('aborted');
  upload.request.write('partial');
  await waitForTempFiles(1);

  const rejected = assert.rejects(upload.response);
  upload.request.destroy();
  await rejected;
  await waitForTempFiles(0);
  assert.deepEqual(await get('aborted'), { status: 404, body: '' });
});

test('a read-only token can retrieve but cannot publish entries', async () => {
  await fetch(cacheUrl('shared'), {
    method: 'PUT',
    headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    body: 'cached-output',
  });

  assert.deepEqual(await get('shared', READ_TOKEN), {
    status: 200,
    body: 'cached-output',
  });
  const denied = await fetch(cacheUrl('read-only-write'), {
    method: 'PUT',
    headers: { authorization: `Bearer ${READ_TOKEN}` },
    body: 'must-not-publish',
  });
  assert.equal(denied.status, 403);
  assert.equal(fs.existsSync(path.join(cacheDir, 'read-only-write')), false);
  const deniedLog = await waitForLog(
    (entry) =>
      entry.event === 'cache_request' &&
      entry.hash === 'read-only-write' &&
      entry.method === 'PUT',
  );
  assert.equal(deniedLog.result, 'read_only');
  assert.equal(deniedLog.sizeBytes, 16);
});

test('unsupported atomic publication errors instead of overwriting', async () => {
  for (const code of ['EXDEV', 'EPERM']) {
    await assert.rejects(
      new Promise((resolve, reject) => {
        const link = (_tmp, _file, callback) => {
          const error = new Error(`link failed: ${code}`);
          error.code = code;
          callback(error);
        };
        publishEntry('tmp', 'final', (error) => {
          if (error) reject(error);
          else resolve();
        }, link);
      }),
      { code },
    );
  }
});

test('access logs contain cache result, hash, size, and duration', async () => {
  const response = await fetch(cacheUrl('logged-entry'), {
    method: 'PUT',
    headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    body: '12345',
  });
  assert.equal(response.status, 200);

  const record = await waitForLog(
    (entry) =>
      entry.event === 'cache_request' &&
      entry.hash === 'logged-entry' &&
      entry.method === 'PUT',
  );
  assert.equal(record.result, 'stored');
  assert.equal(record.status, 200);
  assert.equal(record.sizeBytes, 5);
  assert.equal(typeof record.durationMs, 'number');
  assert.ok(record.durationMs >= 0);
  assert.equal(JSON.stringify(record).includes(WRITE_TOKEN), false);
  assert.equal('tokenName' in record, false);
});

test('parseTokenMap: rejects invalid JSON', () => {
  assert.throws(() => parseTokenMap('not json'), /is not valid JSON/);
});

test('parseTokenMap: rejects a non-object payload', () => {
  assert.throws(() => parseTokenMap('[]'), /must be a JSON object/);
  assert.throws(() => parseTokenMap('"a"'), /must be a JSON object/);
});

test('parseTokenMap: rejects an empty map', () => {
  assert.throws(() => parseTokenMap('{}'), /must contain at least one entry/);
});

test('parseTokenMap: rejects an unrecognized role', () => {
  assert.throws(
    () => parseTokenMap(JSON.stringify({ a: { role: 'admin', token: 't' } })),
    /must have role "read" or "write"/,
  );
});

test('parseTokenMap: rejects a missing token value', () => {
  assert.throws(
    () => parseTokenMap(JSON.stringify({ a: { role: 'write' } })),
    /must have a non-empty "token"/,
  );
});

test('parseTokenMap: rejects two names sharing a token value', () => {
  assert.throws(
    () =>
      parseTokenMap(
        JSON.stringify({
          a: { role: 'write', token: 'same' },
          b: { role: 'read', token: 'same' },
        }),
      ),
    /entries "a" and "b" share the same token value/,
  );
});

test('parseTokenMap: rejects a map with no write-role entry', () => {
  assert.throws(
    () => parseTokenMap(JSON.stringify({ a: { role: 'read', token: 't' } })),
    /must include at least one entry with role "write"/,
  );
});

test('parseTokenMap: accepts a well-formed map and returns flat candidates', () => {
  const candidates = parseTokenMap(
    JSON.stringify({
      writer: { role: 'write', token: 'w' },
      reader: { role: 'read', token: 'r' },
    }),
  );
  assert.deepEqual(candidates, [
    { name: 'writer', token: 'w', role: 'write' },
    { name: 'reader', token: 'r', role: 'read' },
  ]);
});

test('token-map mode: named tokens authenticate with their configured role', async () => {
  const tokensFile = path.join(cacheDir, 'tokens.json');
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      writer: { role: 'write', token: 'writer-token' },
      reader: { role: 'read', token: 'reader-token' },
    }),
  );
  const { proc, port: mapPort } = await spawnServer({
    NX_CACHE_TOKENS_FILE: tokensFile,
  });
  try {
    const url = (hash) => `http://127.0.0.1:${mapPort}/v1/cache/${hash}`;

    const write = await fetch(url('map-entry'), {
      method: 'PUT',
      headers: { authorization: 'Bearer writer-token' },
      body: 'value',
    });
    assert.equal(write.status, 200);

    const read = await fetch(url('map-entry'), {
      headers: { authorization: 'Bearer reader-token' },
    });
    assert.equal(read.status, 200);
    assert.equal(await read.text(), 'value');

    const deniedWrite = await fetch(url('map-entry-2'), {
      method: 'PUT',
      headers: { authorization: 'Bearer reader-token' },
      body: 'nope',
    });
    assert.equal(deniedWrite.status, 403);

    const unknown = await fetch(url('map-entry'), {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(unknown.status, 403);
  } finally {
    await stopServer(proc);
  }
});

test('token-map mode: access logs attribute requests to the matched name', async () => {
  const tokensFile = path.join(cacheDir, 'tokens.json');
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      'build-ci': { role: 'write', token: 'writer-token' },
    }),
  );
  const { proc, port: mapPort, logs: mapLogs } = await spawnServer({
    NX_CACHE_TOKENS_FILE: tokensFile,
  });
  try {
    await fetch(`http://127.0.0.1:${mapPort}/v1/cache/attributed`, {
      method: 'PUT',
      headers: { authorization: 'Bearer writer-token' },
      body: 'value',
    });
    const deadline = Date.now() + 2000;
    let record;
    while (Date.now() < deadline) {
      record = mapLogs.find(
        (entry) => entry.event === 'cache_request' && entry.hash === 'attributed',
      );
      if (record) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(record, 'expected a cache_request log for the attributed hash');
    assert.equal(record.tokenName, 'build-ci');
  } finally {
    await stopServer(proc);
  }
});

test('token-map mode: refuses to start with an empty map', async () => {
  const tokensFile = path.join(cacheDir, 'empty-tokens.json');
  fs.writeFileSync(tokensFile, '{}');
  await assert.rejects(
    spawnServer({ NX_CACHE_TOKENS_FILE: tokensFile }),
    (error) => {
      assert.equal(error.code, 1);
      const startupError = error.logs.find((r) => r.event === 'startup_error');
      assert.match(startupError.error, /must contain at least one entry/);
      return true;
    },
  );
});

test('token-map mode: refuses to start with duplicate token values', async () => {
  const tokensFile = path.join(cacheDir, 'dup-tokens.json');
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      a: { role: 'write', token: 'same-token' },
      b: { role: 'read', token: 'same-token' },
    }),
  );
  await assert.rejects(
    spawnServer({ NX_CACHE_TOKENS_FILE: tokensFile }),
    (error) => {
      const startupError = error.logs.find((r) => r.event === 'startup_error');
      assert.match(startupError.error, /share the same token value/);
      return true;
    },
  );
});

test('token-map mode: refuses to start with no write-role entry', async () => {
  const tokensFile = path.join(cacheDir, 'read-only-tokens.json');
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({ a: { role: 'read', token: 'read-token' } }),
  );
  await assert.rejects(
    spawnServer({ NX_CACHE_TOKENS_FILE: tokensFile }),
    (error) => {
      const startupError = error.logs.find((r) => r.event === 'startup_error');
      assert.match(
        startupError.error,
        /must include at least one entry with role "write"/,
      );
      return true;
    },
  );
});
