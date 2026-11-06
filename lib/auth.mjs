import { AppError, authError, protocolError } from './errors.mjs';

export async function requestJson(server, path, { method = 'GET', token, body, signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(new URL(path, server), {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      headers: { 'x-t3-orchestration-protocol': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(body ? { body } : {}),
    });
  } catch { throw new AppError('network', 'Local T3 HTTP connection failed; retrying with bounded backoff.'); }
  if ([400, 401, 403].includes(response.status)) throw authError();
  if (response.status === 426) throw protocolError();
  if (!response.ok) throw new AppError(`http-${response.status}`, 'Local T3 endpoint unavailable; verify compatibility and server availability.');
  try { return await response.json(); } catch { throw protocolError(); }
}
export function checkScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'orchestration:read') {
    throw new AppError('scope', 'Expected exactly orchestration:read permission; create a narrowly scoped pairing and pair again.', true);
  }
}
export async function descriptor(server, options = {}) {
  const value = await requestJson(server, '/.well-known/t3/environment', options);
  if (value.orchestrationProtocolVersion !== 2 || typeof value.environmentId !== 'string' || value.platform?.os !== 'linux') throw protocolError();
  return value;
}
export async function pair(server, bootstrap, options = {}) {
  const environment = await descriptor(server, options);
  const result = await requestJson(server, '/oauth/token', {
    ...options, method: 'POST', body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: bootstrap,
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'orchestration:read', client_label: 't3-keep-awake', client_device_type: 'bot', client_os: 'linux',
    }),
  });
  // Current T3 issues Bearer when no DPoP proof was supplied. Do not silently
  // use a proof-bound token as Bearer if that server contract ever changes.
  if (result.token_type !== 'Bearer' || typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw protocolError();
  checkScopes(result.scope?.split(/\s+/));
  const credential = { server, environmentId: environment.environmentId, accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  await verifySession(server, credential, options);
  return credential;
}
export async function verifySession(server, credential, options = {}) {
  if (credential.expiresAt <= Date.now()) throw authError();
  const session = await requestJson(server, '/api/auth/session', { ...options, token: credential.accessToken });
  if (session.authenticated !== true) throw authError();
  checkScopes(session.permissions ?? session.scopes);
  return session;
}
export async function socketUrl(server, credential, options = {}) {
  if (credential.expiresAt <= Date.now()) throw authError();
  let ticket;
  try {
    ticket = await requestJson(server, '/api/auth/websocket-ticket/rpc', { ...options, method: 'POST', token: credential.accessToken });
  } catch (error) {
    if (error.code !== 'http-404') throw error;
    ticket = await requestJson(server, '/api/auth/websocket-ticket', { ...options, method: 'POST', token: credential.accessToken });
  }
  if (typeof ticket.ticket !== 'string' || !ticket.ticket || !Number.isFinite(Date.parse(ticket.expiresAt)) || Date.parse(ticket.expiresAt) <= Date.now()) throw protocolError();
  const url = new URL('/ws', server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('orchestrationProtocol', '2');
  url.searchParams.set('wsTicket', ticket.ticket);
  return url;
}
