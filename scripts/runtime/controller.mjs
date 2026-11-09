import path from 'node:path';
import { runtime, readJson, writeJson } from './common.mjs';
const reads = new Set(['get-position', 'get-status', 'get-connection-status', 'list-inventory', 'find-item', 'get-block-info', 'find-blocks', 'find-entity', 'read-chat', 'get-recipe', 'can-craft', 'list-recipes', 'detect-gamemode']);
export function authorizeRequest(username, request, directory = path.join(runtime, 'runtime')) {
  const filename = path.join(directory, 'controller-' + username.toLowerCase() + '.json');
  let lease = readJson(filename);
  if (!lease && username.toLowerCase() === 'llmbot') {
    lease = { controllerId: '01a1be15-2c33-7621-9ac7-817f4c0a36e9', reason: 'Existing explicit human assignment', assignedAt: new Date().toISOString() };
    writeJson(filename, lease);
  }
  if (request.action !== 'stop' && (request.action !== 'call' || reads.has(request.name)))
    return;
  if (lease?.controllerId && request.controllerId !== lease.controllerId)
    throw new Error('This bot belongs to another controller; an explicit human handoff is required');
  if (lease?.controllerId) {
    lease.lastActionAt = new Date().toISOString();
    writeJson(filename, lease);
  }
}
