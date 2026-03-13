/**
 * Simple structured logger.
 * Writes to stderr so it doesn't interfere with MCP stdio transport on stdout.
 */

const levels = { info: 'INFO', warn: 'WARN', error: 'ERROR' };

function log(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: levels[level],
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  info:  (msg, meta) => log('info', msg, meta),
  warn:  (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
