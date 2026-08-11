#!/usr/bin/env node
// Nx self-hosted HTTP remote cache server.
//
// Implements the protocol nx's built-in HTTP client speaks when
// NX_SELF_HOSTED_REMOTE_CACHE_SERVER is set (verified against nx 23.1.0):
//   GET /v1/cache/{hash}  -> 200 + application/octet-stream | 404 | 403
//   PUT /v1/cache/{hash}  -> 200 stored | 409 already exists | 403 read-only
// Auth: `Authorization: Bearer <token>` on every cache request.
//
// Storage is one immutable file per hash under CACHE_DIR. PUTs stream to a
// unique file in that directory, then publish it with an atomic, no-replace
// hard link. Readers therefore see either no entry or one complete entry, and
// concurrent writers cannot replace the first successfully published value.
//
// Entries are pruned on a timer: anything older than MAX_AGE_DAYS goes, then
// oldest-first until the total is under MAX_CACHE_GB. GET refreshes an entry's
// mtime so hot entries survive pruning. No dependencies; state is fully
// derivable (a lost cache only costs recomputation), so the data needs no
// backup. Prometheus can scrape unauthenticated, low-cardinality operational
// metrics at GET /metrics; cache hashes and credential names are never labels.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const CACHE_DIR = process.env.CACHE_DIR || '/data';
const ACCESS_TOKEN = process.env.NX_CACHE_ACCESS_TOKEN;
const READ_ONLY_ACCESS_TOKEN = process.env.NX_CACHE_READ_ONLY_ACCESS_TOKEN;
const TOKENS_FILE = process.env.NX_CACHE_TOKENS_FILE;
const MAX_CACHE_GB = Number(process.env.MAX_CACHE_GB || 50);
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 14);
const PRUNE_INTERVAL_MS = Number(
  process.env.PRUNE_INTERVAL_MS || 60 * 60 * 1000,
);

// Hashes are hex/word characters; anything else is a traversal attempt.
const HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const REQUEST_DURATION_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const processStartedAtSeconds = Date.now() / 1000;

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
  if (!expected || candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
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

function authRole(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;

  if (tokenCandidates) {
    // Walk every candidate and keep comparing after a match, so response
    // timing cannot leak which name (or how many names) are configured.
    let matched = null;
    for (const candidate of tokenCandidates) {
      if (tokenMatches(token, candidate.token)) matched = candidate;
    }
    return matched ? { role: matched.role, name: matched.name } : null;
  }

  if (tokenMatches(token, ACCESS_TOKEN)) return { role: 'write', name: null };
  if (tokenMatches(token, READ_ONLY_ACCESS_TOKEN)) {
    return { role: 'read', name: null };
  }
  return null;
}

function entryPath(hash) {
  return path.join(CACHE_DIR, hash);
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

function prune() {
  let entries;
  try {
    entries = fs
      .readdirSync(CACHE_DIR)
      .filter((file) => HASH_RE.test(file))
      .map((hash) => {
        try {
          const stat = fs.statSync(entryPath(hash));
          return { hash, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    metrics.pruneErrors += 1;
    log('cache_prune_error', { error: error.message }, 'error');
    return;
  }

  const now = Date.now();
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let total = 0;
  let ageEvictions = 0;
  let capacityEvictions = 0;
  let kept = [];
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) {
      try {
        fs.unlinkSync(entryPath(entry.hash));
        ageEvictions += 1;
      } catch {
        metrics.pruneErrors += 1;
        kept.push(entry);
        total += entry.size;
      }
    } else {
      kept.push(entry);
      total += entry.size;
    }
  }

  const maxBytes = MAX_CACHE_GB * 1024 * 1024 * 1024;
  if (total > maxBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of kept) {
      if (total <= maxBytes) break;
      try {
        fs.unlinkSync(entryPath(entry.hash));
        total -= entry.size;
        capacityEvictions += 1;
      } catch {
        metrics.pruneErrors += 1;
      }
    }
  }

  metrics.cacheEntries = entries.length - ageEvictions - capacityEvictions;
  metrics.cacheBytes = total;
  metrics.cacheEvictions.age += ageEvictions;
  metrics.cacheEvictions.capacity += capacityEvictions;

  log('cache_prune', {
    retainedCount: entries.length - ageEvictions - capacityEvictions,
    retainedBytes: total,
    ageEvictions,
    capacityEvictions,
  });
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
  if (req.method === 'GET' && req.url === '/healthz') {
    result = 'healthy';
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
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
    res.writeHead(404).end();
    return;
  }

  const auth = authRole(req);
  if (!auth) {
    result = 'forbidden';
    res.writeHead(403).end();
    return;
  }
  tokenName = auth.name;
  const role = auth.role;
  const file = entryPath(hash);

  if (req.method === 'GET' || req.method === 'HEAD') {
    fs.stat(file, (error, stat) => {
      if (error?.code === 'ENOENT') {
        result = 'miss';
        res.writeHead(404).end();
        return;
      }
      if (error || !stat.isFile()) {
        result = 'read_error';
        log(
          'cache_read_error',
          { hash, error: error?.message || 'entry is not a regular file' },
          'error',
        );
        res.writeHead(500).end();
        return;
      }

      result = 'hit';
      sizeBytes = stat.size;
      fs.utimes(file, new Date(), new Date(), () => {});
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(file);
      stream.on('error', (streamError) => {
        result = 'read_error';
        log(
          'cache_read_error',
          { hash, error: streamError.message },
          'error',
        );
        res.destroy();
      });
      stream.pipe(res);
    });
    return;
  }

  if (req.method === 'PUT') {
    if (role === 'read') {
      result = 'read_only';
      sizeBytes = Number(req.headers['content-length'] || 0);
      req.resume();
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file)) {
      result = 'exists';
      sizeBytes = Number(req.headers['content-length'] || 0);
      req.resume();
      res.writeHead(409).end();
      return;
    }

    req.on('data', (chunk) => {
      sizeBytes += chunk.length;
    });
    const tmp = path.join(
      CACHE_DIR,
      `.tmp-${hash}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
    );
    const output = fs.createWriteStream(tmp, { flags: 'wx' });
    let failed = false;
    const cleanup = () => fs.unlink(tmp, () => {});

    output.on('error', (error) => {
      if (failed) return;
      failed = true;
      result = req.aborted ? 'upload_aborted' : 'write_error';
      log('cache_write_error', { hash, error: error.message }, 'error');
      cleanup();
      if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
    });
    req.on('aborted', () => {
      failed = true;
      result = 'upload_aborted';
      output.destroy();
      cleanup();
    });
    req.pipe(output);
    output.on('finish', () => {
      if (failed) return;
      publishEntry(tmp, file, (error, published) => {
        cleanup();
        if (error) {
          result = 'publish_error';
          log('cache_publish_error', { hash, error: error.message }, 'error');
          res.writeHead(500).end();
        } else if (!published) {
          result = 'exists';
          res.writeHead(409).end();
        } else {
          result = 'stored';
          metrics.cacheEntries += 1;
          metrics.cacheBytes += sizeBytes;
          // Nx 23.1.0 accepts 200, 409, and 403 from store(); 202 is treated
          // as a misconfigured remote-cache endpoint.
          res.writeHead(200).end();
        }
      });
    });
    return;
  }

  result = 'method_not_allowed';
  res.writeHead(405, { allow: 'GET, HEAD, PUT' }).end();
});

if (require.main === module) {
  if (TOKENS_FILE) {
    try {
      tokenCandidates = loadTokenCandidates(TOKENS_FILE);
    } catch (error) {
      log('startup_error', { error: error.message }, 'error');
      process.exit(1);
    }
  } else {
    if (!ACCESS_TOKEN) {
      log(
        'startup_error',
        { error: 'NX_CACHE_ACCESS_TOKEN must be set' },
        'error',
      );
      process.exit(1);
    }
    if (
      READ_ONLY_ACCESS_TOKEN &&
      tokenMatches(READ_ONLY_ACCESS_TOKEN, ACCESS_TOKEN)
    ) {
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

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
  prune();

  server.listen(PORT, () => {
    const address = server.address();
    log('server_started', {
      port: typeof address === 'object' && address ? address.port : PORT,
      cacheDir: CACHE_DIR,
      maxCacheGb: MAX_CACHE_GB,
      maxAgeDays: MAX_AGE_DAYS,
      tokenMode: tokenCandidates ? 'map' : 'legacy',
      ...(tokenCandidates
        ? {}
        : { readOnlyTokenEnabled: Boolean(READ_ONLY_ACCESS_TOKEN) }),
    });
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

module.exports = { publishEntry, parseTokenMap };
