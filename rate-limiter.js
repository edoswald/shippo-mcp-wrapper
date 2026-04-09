// rate-limiter.js — standalone ESM module, no dependencies

/**
 * Extracts client IP from request.
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
export function getClientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Creates a rate limiter instance.
 * @param {Object} options
 * @param {number} options.windowMs - Window duration in milliseconds
 * @param {number} options.max - Maximum requests per window per IP
 * @param {boolean} [options.trustProxy=true] - Use x-forwarded-for for IP
 * @returns {{ check: Function, destroy: Function, _store: Map }}
 */
export function createRateLimiter({ windowMs, max, trustProxy = true }) {
  /** @type {Map<string, { count: number, windowStart: number }>} */
  const store = new Map();

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of store) {
      if (now - entry.windowStart >= windowMs) {
        store.delete(ip);
      }
    }
  }, windowMs);

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  /**
   * Check if a request is within rate limits.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {Object} [options]
   * @param {string} [options.errorMessage='Too many requests, please try again later.']
   * @returns {boolean} true if request is allowed
   */
  function check(req, res, { errorMessage = 'Too many requests, please try again later.' } = {}) {
    const ip = getClientIp(req, trustProxy);
    const now = Date.now();

    let entry = store.get(ip);

    if (entry && now - entry.windowStart >= windowMs) {
      entry = undefined;
    }

    if (!entry) {
      entry = { count: 0, windowStart: now };
      store.set(ip, entry);
    }

    entry.count++;

    const resetTimestamp = Math.ceil((entry.windowStart + windowMs) / 1000);

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
      const body = JSON.stringify({ error: errorMessage });

      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSeconds),
        'RateLimit-Limit': String(max),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(resetTimestamp),
      });
      res.end(body);
      return false;
    }

    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(statusCode, ...args) {
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(max - entry.count));
      res.setHeader('RateLimit-Reset', String(resetTimestamp));
      return originalWriteHead(statusCode, ...args);
    };

    return true;
  }

  function destroy() {
    clearInterval(cleanupInterval);
  }

  return { check, destroy, _store: store };
}
