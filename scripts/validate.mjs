import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const path = new URL('../popup-sentinel.user.js', import.meta.url);
const source = await readFile(path, 'utf8');

assert.match(source, /^\/\/ ==UserScript==/);
assert.match(source, /\/\/ @name\s+Popup Sentinel/);
assert.match(source, /\/\/ @version\s+\d+\.\d+\.\d+/);
assert.match(source, /\/\/ @run-at\s+document-start/);
assert.match(source, /\/\/ @inject-into\s+page/);
assert.match(source, /\/\/ @match\s+https:\/\/embed\.st\/\*/);
assert.doesNotMatch(source, /window\.open\s*=\s*\(\)\s*=>\s*null/);

new vm.Script(source, { filename: 'popup-sentinel.user.js' });
console.log('Userscript metadata and syntax are valid.');
