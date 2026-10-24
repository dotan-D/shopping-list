'use strict';
// Test-only REST transport: execute the real production Redis commands against
// an isolated local Redis socket. No external service or credentials are used.
const { spawnSync } = require('node:child_process');
const endpoint = 'https://shopping-redis.example.test/';
function installRedisAdapter() {
  if (!process.env.REDIS_TEST_SOCKET) throw new Error('Set REDIS_TEST_SOCKET to an isolated test Redis socket.');
  const nativeFetch = global.fetch;
  process.env.KV_REST_API_URL = endpoint;
  process.env.KV_REST_API_TOKEN = 'local-test-only';
  let unavailable = false;
  const command = parts => {
    const result = spawnSync(process.env.REDIS_TEST_CLI || 'redis-cli', ['-s', process.env.REDIS_TEST_SOCKET, '--raw', ...parts], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Test Redis command failed');
    const lines = result.stdout.replace(/\n$/, '').split('\n');
    if (/^(ERR|WRONGTYPE|OOM)/.test(result.stdout)) throw new Error('Test Redis command failed');
    if (parts[0] === 'HGETALL') return result.stdout === '\n' ? [] : lines;
    if (parts[0] === 'EVAL' && lines.length === 2) return [Number(lines[0]), lines[1]];
    return Number(lines[0]);
  };
  global.fetch = async (url, options) => {
    if (String(url) !== endpoint) return nativeFetch(url, options);
    if (unavailable) throw new Error('Simulated database outage');
    if (options.headers.Authorization !== 'Bearer local-test-only') throw new Error('Missing backend authentication');
    return Response.json({ result: command(JSON.parse(options.body)) });
  };
  return { command, setUnavailable(value) { unavailable = value; }, restore() { global.fetch = nativeFetch; } };
}
module.exports = { installRedisAdapter };
