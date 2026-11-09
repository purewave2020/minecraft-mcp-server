import test from 'ava';
import { spawnSync } from 'node:child_process';

function run(source: string) {
  return spawnSync(process.execPath, ['--import=tsx', '--input-type=module', '-e',
    "import {setupStdioFiltering} from './src/stdio-filter.ts'; setupStdioFiltering();" + source], { encoding: 'utf8' });
}

test('only JSON-RPC messages enter stdout and all diagnostics remain on stderr', t => {
  const result = run(`
    process.stdout.write('2026-11-09T00:00:00Z log\\n');
    process.stdout.write('{"debug":true}\\n');
    console.error('protocol error details');
    console.log('library log');
    process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\\n');
    process.stdout.write('{"jsonrpc":"2.0","method":"notifications/progress"}\\n');
  `);
  t.is(result.status, 0);
  t.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)), [
    { jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', method: 'notifications/progress' }
  ]);
  t.regex(result.stderr, /protocol error details/);
  t.regex(result.stderr, /2026-11-09/);
  t.regex(result.stderr, /library log/);
  t.regex(result.stderr, /debug/);
});

test('redirected writes still invoke callbacks and empty lines do not corrupt framing', t => {
  const result = run(`
    process.stdout.write('diagnostic', () => process.stderr.write('callback-ran\\n'));
    process.stdout.write('\\n');
    process.stdout.write('{"jsonrpc":"2.0","id":null,"error":{"code":-1,"message":"x"}}\\n');
  `);
  t.is(result.status, 0);
  t.regex(result.stderr, /callback-ran/);
  t.is(result.stdout.trim().split('\n').length, 1);
  t.is(JSON.parse(result.stdout).error.code, -1);
});
