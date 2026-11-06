import test from 'node:test';
import assert from 'node:assert/strict';
import { pair, socketUrl, verifySession, requestJson } from '../lib/auth.mjs';
import { safeError } from '../lib/errors.mjs';
const server = 'http://127.0.0.1:12345';
const environment = { environmentId: 'env', platform: { os: 'linux' }, orchestrationProtocolVersion: 2, serverVersion: '0.1.7' };
const token = { token_type: 'Bearer', access_token: 'PRIVATE-TOKEN', expires_in: 1000, scope: 'orchestration:read' };
const credential = { accessToken: 'PRIVATE-TOKEN', expiresAt: Date.now() + 100000 };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('pair requests narrow scope, consumes bootstrap once, verifies effective permissions', async () => {
  const calls = [];
  const results = [environment, token, { authenticated: true, permissions: ['orchestration:read'] }];
  const value = await pair(server, 'PRIVATE-BOOTSTRAP', { fetchImpl: async (url, options) => { calls.push({ url, options }); return response(results.shift()); } });
  assert.equal(value.environmentId, 'env');
  assert.equal(value.accessToken, token.access_token);
  assert.equal(calls[1].options.body.get('scope'), 'orchestration:read');
  assert.equal(calls[1].options.body.get('subject_token'), 'PRIVATE-BOOTSTRAP');
  assert.equal(calls[1].options.headers.dpop, undefined);
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(JSON.stringify(value).includes('PRIVATE-BOOTSTRAP'), false);
});
test('reject broader grants even if server ignores requested scope', async () => {
  const results = [environment, { ...token, scope: 'orchestration:read filesystem:read' }];
  await assert.rejects(pair(server, 'secret', { fetchImpl: async () => response(results.shift()) }), { code: 'scope' });
});
test('session uses permissions rather than legacy compatibility scopes', async () => {
  await assert.rejects(verifySession(server, credential, { fetchImpl: async () => response({ authenticated: true, scopes: ['orchestration:read'], permissions: ['orchestration:read', 'filesystem:read'] }) }), { code: 'scope' });
});
test('auth expiry/revocation is actionable and response secrets never appear in errors', async () => {
  await assert.rejects(verifySession(server, { ...credential, expiresAt: 0 }), { code: 'auth', fatal: true });
  try { await requestJson(server, '/oauth/token', { fetchImpl: async () => response({ error: 'PRIVATE-TOKEN' }, 401) }); assert.fail(); }
  catch (error) { assert.equal(error.code, 'auth'); assert.equal(safeError(error).includes('PRIVATE'), false); }
});
test('RPC ticket audience endpoint falls back only on 404; URL carries protocol 2', async () => {
  const calls = [];
  const url = await socketUrl(server, credential, { fetchImpl: async url => {
    calls.push(url.pathname);
    return calls.length === 1 ? response({}, 404) : response({ ticket: 'PRIVATE-TICKET', expiresAt: new Date(Date.now() + 60000).toISOString() });
  } });
  assert.deepEqual(calls, ['/api/auth/websocket-ticket/rpc', '/api/auth/websocket-ticket']);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.searchParams.get('orchestrationProtocol'), '2');
  assert.equal(url.searchParams.get('wsTicket'), 'PRIVATE-TICKET');
});
test('reject DPoP tokens rather than misusing them as Bearer', async () => {
  const results = [environment, { ...token, token_type: 'DPoP' }];
  await assert.rejects(pair(server, 'secret', { fetchImpl: async () => response(results.shift()) }), { code: 'protocol' });
});
