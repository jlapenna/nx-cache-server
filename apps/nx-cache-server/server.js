#!/usr/bin/env node
// Nx self-hosted HTTP remote cache server.
//
// Implements the protocol nx's built-in HTTP client speaks when
// NX_SELF_HOSTED_REMOTE_CACHE_SERVER is set (verified against nx 24.0.6):
//   GET /v1/cache/{hash}  -> 200 + application/octet-stream | 404 | 401 (text/plain)
//   PUT /v1/cache/{hash}  -> 200 stored | 409 already exists | 403 read-only | 401 (text/plain)
// Auth: `Authorization: Bearer <token>` on every cache request.
//
// Storage is one immutable file per hash under CACHE_DIR. PUTs stream to a
// unique file in that directory, then publish it with an atomic, no-replace
// hard link. Readers therefore see either no entry or one complete entry, and
// concurrent writers cannot replace the first successfully published value.
//
// Entries are pruned asynchronously on a timer: anything older than
// MAX_AGE_DAYS goes, then oldest-first until the total is under MAX_CACHE_GB.
// Stale orphaned `.tmp-*` upload files older than ORPHAN_TMP_MAX_AGE_MS are
// also removed during pruning. GET refreshes an entry's mtime (throttled by
// MTIME_REFRESH_INTERVAL_MS) so hot entries survive pruning without redundant
// metadata writes. No dependencies; state is fully derivable (a lost cache
// only costs recomputation), so the data needs no backup. Prometheus can
// scrape unauthenticated, low-cardinality operational metrics at GET /metrics;
// cache hashes and credential names are never labels.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');

// Hashes are hex/word characters; anything else is a traversal attempt.
const HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const REQUEST_DURATION_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const STREAM_HIGH_WATER_MARK = 256 * 1024;
const PRUNE_STAT_CONCURRENCY = 32;
const KEEP_ALIVE_TIMEOUT_MS = 60 * 1000;
const HEADERS_TIMEOUT_MS = 65 * 1000;
const processStartedAtSeconds = Date.now() / 1000;

function parseNumberEnv(
  env,
  name,
  defaultValue,
  { min = 0, max = Infinity, integer = false, allowMin = false } = {},
) {
  const raw = env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  const meetsMin = allowMin ? value >= min : value > min;
  if (
    !Number.isFinite(value) ||
    !meetsMin ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    const comparator = allowMin ? '>=' : '>';
    const bound = Number.isFinite(max) ? `${min}..${max}` : `${comparator} ${min}`;
    throw new Error(
      `${name} must be a valid ${integer ? 'integer' : 'number'} (${bound})`,
    );
  }
  return value;
}

function parseConfig(env) {
  return {
    port: parseNumberEnv(env, 'PORT', 3000, {
      min: 0,
      max: 65535,
      integer: true,
      allowMin: true,
    }),
    cacheDir: env.CACHE_DIR || '/data',
    accessToken: env.NX_CACHE_ACCESS_TOKEN,
    readOnlyAccessToken: env.NX_CACHE_READ_ONLY_ACCESS_TOKEN,
    tokensFile: env.NX_CACHE_TOKENS_FILE,
    maxCacheGb: parseNumberEnv(env, 'MAX_CACHE_GB', 50, { min: 0 }),
    maxAgeDays: parseNumberEnv(env, 'MAX_AGE_DAYS', 14, { min: 0 }),
    pruneIntervalMs: parseNumberEnv(env, 'PRUNE_INTERVAL_MS', 60 * 60 * 1000, {
      min: 0,
    }),
    orphanTmpMaxAgeMs: parseNumberEnv(
      env,
      'ORPHAN_TMP_MAX_AGE_MS',
      60 * 60 * 1000,
      { min: 0, allowMin: true },
    ),
    mtimeRefreshIntervalMs: parseNumberEnv(
      env,
      'MTIME_REFRESH_INTERVAL_MS',
      60 * 1000,
      { min: 0, allowMin: true },
    ),
  };
}

let config = {
  port: 3000,
  cacheDir: '/data',
  accessToken: undefined,
  readOnlyAccessToken: undefined,
  tokensFile: undefined,
  maxCacheGb: 50,
  maxAgeDays: 14,
  pruneIntervalMs: 60 * 60 * 1000,
  orphanTmpMaxAgeMs: 60 * 60 * 1000,
  mtimeRefreshIntervalMs: 60 * 1000,
};

// The server deliberately has no runtime dependencies, including a Prometheus
// client. Keep these metrics to bounded label sets: arbitrary cache hashes,
// request paths, and credential names would make Prometheus cardinality grow
// without limit.
const metrics = {
  cacheBytes: 0,
  cacheEntries: 0,
  cacheEvictions: { age: 0, capacity: 0 },
  httpRequests: new Map(),
  httpRequestDurations: new Map(),
  inFlightRequests: 0,
  pruneErrors: 0,
};

function parseContentLength(header) {
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function prometheusMethod(method) {
  return ['GET', 'HEAD', 'PUT'].includes(method) ? method : 'OTHER';
}

function prometheusLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries
    .map(([name, value]) => {
      const escaped = String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll('\n', '\\n')
        .replaceAll('"', '\\"');
      return `${name}="${escaped}"`;
    })
    .join(',')}}`;
}

function recordRequestMetrics(req, res, result, durationSeconds) {
  metrics.inFlightRequests = Math.max(0, metrics.inFlightRequests - 1);

  const method = prometheusMethod(req.method);
  const status = String(res.statusCode);
  const requestKey = `${method}\0${result}\0${status}`;
  metrics.httpRequests.set(
    requestKey,
    (metrics.httpRequests.get(requestKey) || 0) + 1,
  );

  const durationKey = `${method}\0${status}`;
  let duration = metrics.httpRequestDurations.get(durationKey);
  if (!duration) {
    duration = {
      buckets: REQUEST_DURATION_BUCKETS.map(() => 0),
      count: 0,
      sum: 0,
    };
    metrics.httpRequestDurations.set(durationKey, duration);
  }
  duration.count += 1;
  duration.sum += durationSeconds;
  for (const [index, bucket] of REQUEST_DURATION_BUCKETS.entries()) {
    if (durationSeconds <= bucket) duration.buckets[index] += 1;
  }
}

function renderPrometheusMetrics() {
  const lines = [
    '# HELP nx_cache_server_process_start_time_seconds Unix time when the server started.',
    '# TYPE nx_cache_server_process_start_time_seconds gauge',
    `nx_cache_server_process_start_time_seconds ${processStartedAtSeconds}`,
    '# HELP nx_cache_server_http_requests_in_flight Current HTTP requests being handled.',
    '# TYPE nx_cache_server_http_requests_in_flight gauge',
    `nx_cache_server_http_requests_in_flight ${metrics.inFlightRequests}`,
    '# HELP nx_cache_server_http_requests_total Completed HTTP requests by method, result, and status.',
    '# TYPE nx_cache_server_http_requests_total counter',
  ];
  for (const [key, count] of [...metrics.httpRequests.entries()].sort()) {
    const [method, result, status] = key.split('\0');
    lines.push(
      `nx_cache_server_http_requests_total${prometheusLabels({ method, result, status })} ${count}`,
    );
  }

  lines.push(
    '# HELP nx_cache_server_http_request_duration_seconds Completed HTTP request duration in seconds.',
    '# TYPE nx_cache_server_http_request_duration_seconds histogram',
  );
  for (const [key, duration] of [
    ...metrics.httpRequestDurations.entries(),
  ].sort()) {
    const [method, status] = key.split('\0');
    for (const [index, bucket] of REQUEST_DURATION_BUCKETS.entries()) {
      lines.push(
        `nx_cache_server_http_request_duration_seconds_bucket${prometheusLabels({ le: bucket, method, status })} ${duration.buckets[index]}`,
      );
    }
    lines.push(
      `nx_cache_server_http_request_duration_seconds_bucket${prometheusLabels({ le: '+Inf', method, status })} ${duration.count}`,
      `nx_cache_server_http_request_duration_seconds_sum${prometheusLabels({ method, status })} ${duration.sum}`,
      `nx_cache_server_http_request_duration_seconds_count${prometheusLabels({ method, status })} ${duration.count}`,
    );
  }

  lines.push(
    '# HELP nx_cache_server_cache_entries Number of published cache entries.',
    '# TYPE nx_cache_server_cache_entries gauge',
    `nx_cache_server_cache_entries ${metrics.cacheEntries}`,
    '# HELP nx_cache_server_cache_size_bytes Total size of published cache entries in bytes.',
    '# TYPE nx_cache_server_cache_size_bytes gauge',
    `nx_cache_server_cache_size_bytes ${metrics.cacheBytes}`,
    '# HELP nx_cache_server_cache_evictions_total Cache entries removed by pruning.',
    '# TYPE nx_cache_server_cache_evictions_total counter',
  );
  for (const reason of ['age', 'capacity']) {
    lines.push(
      `nx_cache_server_cache_evictions_total${prometheusLabels({ reason })} ${metrics.cacheEvictions[reason]}`,
    );
  }
  lines.push(
    '# HELP nx_cache_server_cache_prune_errors_total Cache pruning errors.',
    '# TYPE nx_cache_server_cache_prune_errors_total counter',
    `nx_cache_server_cache_prune_errors_total ${metrics.pruneErrors}`,
  );
  return `${lines.join('\n')}\n`;
}

function log(event, fields = {}, level = 'info') {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function tokenMatches(candidate, expected) {
  if (!expected) return false;
  const candidateBuf = Buffer.isBuffer(candidate)
    ? candidate
    : Buffer.from(candidate, 'utf8');
  const expectedBuf = Buffer.isBuffer(expected)
    ? expected
    : Buffer.from(expected, 'utf8');
  if (candidateBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

// Parses and validates a NX_CACHE_TOKENS_FILE payload (raw JSON text) into a
// flat list of { name, token, role }. Throws with a human-readable message
// on any invalid shape; callers decide how to surface that.
function parseTokenMap(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`is not valid JSON: ${error.message}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('must be a JSON object mapping names to entries');
  }

  const names = Object.keys(parsed);
  if (names.length === 0) {
    throw new Error('must contain at least one entry');
  }

  const candidates = [];
  const nameByToken = new Map();
  let hasWrite = false;
  for (const name of names) {
    const entry = parsed[name];
    const role = entry && entry.role;
    if (role !== 'read' && role !== 'write') {
      throw new Error(`entry "${name}" must have role "read" or "write"`);
    }
    const token = entry && entry.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`entry "${name}" must have a non-empty "token"`);
    }
    if (nameByToken.has(token)) {
      throw new Error(
        `entries "${nameByToken.get(token)}" and "${name}" share the same token value`,
      );
    }
    nameByToken.set(token, name);
    if (role === 'write') hasWrite = true;
    candidates.push({ name, token, role });
  }
  if (!hasWrite) {
    throw new Error('must include at least one entry with role "write"');
  }
  return candidates;
}

function loadTokenCandidates(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read NX_CACHE_TOKENS_FILE (${filePath}): ${error.message}`,
    );
  }
  try {
    return parseTokenMap(raw);
  } catch (error) {
    throw new Error(`NX_CACHE_TOKENS_FILE (${filePath}) ${error.message}`);
  }
}

// Populated at startup below when NX_CACHE_TOKENS_FILE is set; stays null
// (legacy two-scalar-token mode) otherwise.
let tokenCandidates = null;
let accessTokenBuf = null;
let readOnlyAccessTokenBuf = null;

function authRole(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token.length === 0) return null;
  const candidateBuf = Buffer.from(token, 'utf8');

  if (tokenCandidates) {
    // Walk every candidate and keep comparing after a match, so response
    // timing cannot leak which name (or how many names) are configured.
    let matched = null;
    for (const candidate of tokenCandidates) {
      if (tokenMatches(candidateBuf, candidate.tokenBuf)) matched = candidate;
    }
    return matched ? { role: matched.role, name: matched.name } : null;
  }

  let matched = null;
  if (tokenMatches(candidateBuf, accessTokenBuf)) {
    matched = { role: 'write', name: null };
  }
  if (tokenMatches(candidateBuf, readOnlyAccessTokenBuf)) {
    matched = { role: 'read', name: null };
  }
  return matched;
}

function entryPath(hash) {
  return path.join(config.cacheDir, hash);
}

// Publish without replacing an existing entry. Any error except EEXIST is
// deliberately propagated: falling back to rename would restore the
// concurrent overwrite race this operation prevents.
function publishEntry(tmp, file, callback, link = fs.link) {
  link(tmp, file, (error) => {
    if (error?.code === 'EEXIST') {
      callback(null, false);
    } else if (error) {
      callback(error);
    } else {
      callback(null, true);
    }
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

let pruning = false;
let activePruneDelta = null;

async function prune() {
  if (pruning) return;
  pruning = true;

  try {
    let dirEntries;
    try {
      dirEntries = await fs.promises.readdir(config.cacheDir);
    } catch (error) {
      metrics.pruneErrors += 1;
      log('cache_prune_error', { error: error.message }, 'error');
      return;
    }

    const delta = { entries: 0, bytes: 0 };
    activePruneDelta = delta;

    const now = Date.now();
    const cacheNames = [];
    const tmpNames = [];
    for (const name of dirEntries) {
      if (HASH_RE.test(name)) {
        cacheNames.push(name);
      } else if (name.startsWith('.tmp-')) {
        tmpNames.push(name);
      }
    }

    // Remove orphaned temporary upload files left behind by crashed processes.
    let orphanTmpRemoved = 0;
    if (tmpNames.length > 0) {
      await mapWithConcurrency(
        tmpNames,
        PRUNE_STAT_CONCURRENCY,
        async (name) => {
          const tmpPath = entryPath(name);
          try {
            const stat = await fs.promises.stat(tmpPath);
            if (
              stat.isFile() &&
              now - stat.mtimeMs > config.orphanTmpMaxAgeMs
            ) {
              await fs.promises.unlink(tmpPath);
              orphanTmpRemoved += 1;
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              metrics.pruneErrors += 1;
            }
          }
        },
      );
    }

    const rawEntries = await mapWithConcurrency(
      cacheNames,
      PRUNE_STAT_CONCURRENCY,
      async (hash) => {
        try {
          const stat = await fs.promises.stat(entryPath(hash));
          if (!stat.isFile()) return null;
          return { hash, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      },
    );
    const entries = rawEntries.filter(Boolean);

    const maxAgeMs = config.maxAgeDays * 24 * 60 * 60 * 1000;
    let total = 0;
    let ageEvictions = 0;
    let capacityEvictions = 0;
    const kept = [];
    const expired = [];
    for (const entry of entries) {
      if (now - entry.mtimeMs > maxAgeMs) {
        expired.push(entry);
      } else {
        kept.push(entry);
        total += entry.size;
      }
    }

    if (expired.length > 0) {
      await mapWithConcurrency(
        expired,
        PRUNE_STAT_CONCURRENCY,
        async (entry) => {
          try {
            await fs.promises.unlink(entryPath(entry.hash));
            ageEvictions += 1;
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              metrics.pruneErrors += 1;
              kept.push(entry);
              total += entry.size;
            }
          }
        },
      );
    }

    const maxBytes = config.maxCacheGb * 1024 * 1024 * 1024;
    if (total > maxBytes) {
      kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const toEvict = [];
      for (const entry of kept) {
        if (total <= maxBytes) break;
        total -= entry.size;
        toEvict.push(entry);
      }
      await mapWithConcurrency(
        toEvict,
        PRUNE_STAT_CONCURRENCY,
        async (entry) => {
          try {
            await fs.promises.unlink(entryPath(entry.hash));
            capacityEvictions += 1;
          } catch (error) {
            if (error?.code !== 'ENOENT') {
              metrics.pruneErrors += 1;
              total += entry.size;
            }
          }
        },
      );
    }

    const retainedCount = kept.length - capacityEvictions + delta.entries;
    const retainedBytes = total + delta.bytes;
    metrics.cacheEntries = retainedCount;
    metrics.cacheBytes = retainedBytes;
    metrics.cacheEvictions.age += ageEvictions;
    metrics.cacheEvictions.capacity += capacityEvictions;

    log('cache_prune', {
      retainedCount,
      retainedBytes,
      ageEvictions,
      capacityEvictions,
      ...(orphanTmpRemoved > 0 && { orphanTmpRemoved }),
    });
  } finally {
    activePruneDelta = null;
    pruning = false;
  }
}

const server = http.createServer((req, res) => {
  const startedAt = process.hrtime.bigint();
  metrics.inFlightRequests += 1;
  let hash = null;
  let result = 'unknown';
  let sizeBytes = 0;
  let tokenName = null;
  let logged = false;

  const logAccess = () => {
    if (logged) return;
    logged = true;
    const elapsedNs = process.hrtime.bigint() - startedAt;
    recordRequestMetrics(req, res, result, Number(elapsedNs) / 1_000_000_000);
    log('cache_request', {
      method: req.method,
      path: req.url,
      ...(hash && { hash }),
      status: res.statusCode,
      result,
      sizeBytes,
      ...(tokenName && { tokenName }),
      durationMs: Number(
        (Number(elapsedNs) / 1_000_000).toFixed(3),
      ),
    });
  };
  res.once('finish', logAccess);
  res.once('close', () => {
    if (!res.writableFinished) {
      if (result === 'unknown') result = 'connection_closed';
      logAccess();
    }
  });

  // Metrics are intentionally unauthenticated so the Prometheus server on the
  // management network can scrape the endpoint. They include no hashes,
  // tokens, paths, or other unbounded labels.
  if (
    req.url === '/metrics' &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    result = 'metrics';
    const body = renderPrometheusMetrics();
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      'content-type': PROMETHEUS_CONTENT_TYPE,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  // Unauthenticated liveness probe for monitoring.
  if (
    req.url === '/healthz' &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    result = 'healthy';
    res.writeHead(200, {
      'content-type': 'text/plain',
      'content-length': 3,
    });
    res.end(req.method === 'HEAD' ? undefined : 'ok\n');
    return;
  }

  let match;
  try {
    match = req.url && req.url.match(/^\/v1\/cache\/([^/]+)$/);
    hash = match && decodeURIComponent(match[1]);
  } catch {
    hash = null;
  }
  if (!match || typeof hash !== 'string' || !HASH_RE.test(hash)) {
    result = 'invalid_path';
    if (req.method === 'PUT') req.resume();
    res.writeHead(404).end();
    return;
  }

  const auth = authRole(req);
  if (!auth) {
    // Nx's HTTP remote cache client maps 401 with exact `content-type:
    // text/plain` to Unauthorized; 403 on PUT is treated as a read-only token.
    result = 'unauthorized';
    if (req.method === 'PUT') {
      sizeBytes = parseContentLength(req.headers['content-length']);
      req.resume();
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end(req.method === 'HEAD' ? undefined : 'Unauthorized\n');
    return;
  }
  tokenName = auth.name;
  const role = auth.role;
  const file = entryPath(hash);

  if (req.method === 'GET' || req.method === 'HEAD') {
    // Open once and fstat the descriptor so a concurrent prune() unlink cannot
    // race between stat and read and produce a truncated 200 response.
    fs.open(file, 'r', (openError, fd) => {
      if (openError?.code === 'ENOENT') {
        result = 'miss';
        if (!res.headersSent && !res.destroyed) res.writeHead(404).end();
        return;
      }
      if (openError) {
        result = 'read_error';
        log('cache_read_error', { hash, error: openError.message }, 'error');
        if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
        return;
      }
      if (res.destroyed) {
        fs.close(fd, () => {});
        return;
      }

      fs.fstat(fd, (statError, stat) => {
        if (statError || !stat.isFile()) {
          fs.close(fd, () => {});
          result = 'read_error';
          log(
            'cache_read_error',
            {
              hash,
              error: statError?.message || 'entry is not a regular file',
            },
            'error',
          );
          if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
          return;
        }
        if (res.destroyed) {
          fs.close(fd, () => {});
          return;
        }

        result = 'hit';
        sizeBytes = stat.size;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': stat.size,
        });
        if (req.method === 'HEAD') {
          fs.close(fd, () => {});
          res.end();
          return;
        }

        const nowMs = Date.now();
        if (nowMs - stat.mtimeMs >= config.mtimeRefreshIntervalMs) {
          const now = new Date(nowMs);
          fs.utimes(file, now, now, () => {});
        }

        const stream = fs.createReadStream(null, {
          fd,
          autoClose: true,
          highWaterMark: STREAM_HIGH_WATER_MARK,
        });
        pipeline(stream, res, (streamError) => {
          if (!streamError) return;
          if (streamError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
            result = 'connection_closed';
            return;
          }
          result = 'read_error';
          log('cache_read_error', { hash, error: streamError.message }, 'error');
        });
      });
    });
    return;
  }

  if (req.method === 'PUT') {
    if (role === 'read') {
      result = 'read_only';
      sizeBytes = parseContentLength(req.headers['content-length']);
      req.resume();
      res
        .writeHead(403, { 'content-type': 'text/plain' })
        .end('Read-only token\n');
      return;
    }

    fs.access(file, fs.constants.F_OK, (accessError) => {
      if (!accessError) {
        result = 'exists';
        sizeBytes = parseContentLength(req.headers['content-length']);
        req.resume();
        if (!res.headersSent && !res.destroyed) res.writeHead(409).end();
        return;
      }
      if (accessError.code !== 'ENOENT') {
        result = 'write_error';
        log('cache_write_error', { hash, error: accessError.message }, 'error');
        req.resume();
        if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
        return;
      }
      if (req.destroyed || res.destroyed) {
        result = 'upload_aborted';
        return;
      }

      req.on('data', (chunk) => {
        sizeBytes += chunk.length;
      });
      const tmp = path.join(
        config.cacheDir,
        `.tmp-${hash}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
      );
      const output = fs.createWriteStream(tmp, {
        flags: 'wx',
        highWaterMark: STREAM_HIGH_WATER_MARK,
      });
      const cleanup = () => fs.unlink(tmp, () => {});

      pipeline(req, output, (pipeError) => {
        if (pipeError || !req.complete) {
          cleanup();
          const aborted =
            !req.complete ||
            pipeError?.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
            pipeError?.code === 'ECONNRESET';
          result = aborted ? 'upload_aborted' : 'write_error';
          if (!aborted && pipeError) {
            log('cache_write_error', { hash, error: pipeError.message }, 'error');
          }
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(aborted ? 400 : 500).end();
          }
          return;
        }

        publishEntry(tmp, file, (error, published) => {
          cleanup();
          if (error) {
            result = 'publish_error';
            log('cache_publish_error', { hash, error: error.message }, 'error');
            if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
          } else if (!published) {
            result = 'exists';
            if (!res.headersSent && !res.destroyed) res.writeHead(409).end();
          } else {
            result = 'stored';
            metrics.cacheEntries += 1;
            metrics.cacheBytes += sizeBytes;
            if (activePruneDelta) {
              activePruneDelta.entries += 1;
              activePruneDelta.bytes += sizeBytes;
            }
            // Nx 24.0.6 accepts 200, 409, and 403 from store(); 202 is treated
            // as a misconfigured remote-cache endpoint.
            if (!res.headersSent && !res.destroyed) res.writeHead(200).end();
          }
        });
      });
    });
    return;
  }

  result = 'method_not_allowed';
  res.writeHead(405, { allow: 'GET, HEAD, PUT' }).end();
});

server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
server.headersTimeout = HEADERS_TIMEOUT_MS;

if (require.main === module) {
  try {
    config = parseConfig(process.env);
  } catch (error) {
    log('startup_error', { error: error.message }, 'error');
    process.exit(1);
  }

  if (config.tokensFile) {
    try {
      tokenCandidates = loadTokenCandidates(config.tokensFile).map((entry) => ({
        ...entry,
        tokenBuf: Buffer.from(entry.token, 'utf8'),
      }));
    } catch (error) {
      log('startup_error', { error: error.message }, 'error');
      process.exit(1);
    }
  } else {
    if (!config.accessToken) {
      log(
        'startup_error',
        { error: 'NX_CACHE_ACCESS_TOKEN must be set' },
        'error',
      );
      process.exit(1);
    }
    accessTokenBuf = Buffer.from(config.accessToken, 'utf8');
    if (config.readOnlyAccessToken) {
      readOnlyAccessTokenBuf = Buffer.from(config.readOnlyAccessToken, 'utf8');
      if (tokenMatches(readOnlyAccessTokenBuf, accessTokenBuf)) {
        log(
          'startup_error',
          {
            error:
              'NX_CACHE_READ_ONLY_ACCESS_TOKEN must differ from NX_CACHE_ACCESS_TOKEN',
          },
          'error',
        );
        process.exit(1);
      }
    }
  }

  fs.mkdirSync(config.cacheDir, { recursive: true });
  const pruneTimer = setInterval(() => {
    void prune();
  }, config.pruneIntervalMs);
  pruneTimer.unref();
  void prune();

  server.listen(config.port, () => {
    const address = server.address();
    log('server_started', {
      port: typeof address === 'object' && address ? address.port : config.port,
      cacheDir: config.cacheDir,
      maxCacheGb: config.maxCacheGb,
      maxAgeDays: config.maxAgeDays,
      tokenMode: tokenCandidates ? 'map' : 'legacy',
      ...(tokenCandidates
        ? {}
        : { readOnlyTokenEnabled: Boolean(readOnlyAccessTokenBuf) }),
    });
  });

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(pruneTimer);
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = { publishEntry, parseTokenMap, parseConfig, tokenMatches };
