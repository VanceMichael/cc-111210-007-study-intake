import test from 'node:test';
import assert from 'node:assert/strict';
import { FetchPolicy } from '../src/policy.mjs';
import { listen } from '../src/http.mjs';

test('回环与同源默认可访问，未授权外域被拒绝', () => {
  const policy = new FetchPolicy({ source: 'http://127.0.0.1:9001/gw' });
  assert.ok(policy.authorize('http://127.0.0.1:9001/bulk/1'));
  assert.ok(policy.authorize('http://localhost:9001/bulk/1'));
  assert.equal(policy.authorize('https://imaging.example.edu/bulk/1'), null);
  assert.throws(() => policy.assertAuthorized('https://imaging.example.edu/bulk/1'), /授权清单/);
  assert.equal(policy.authorize('file:///etc/passwd'), null);
  assert.throws(() => new FetchPolicy({ source: 'http://x', allowedOrigins: ['ftp://bad'] }), /协议不允许/);

  const allowed = new FetchPolicy({
    source: 'http://127.0.0.1:9001',
    allowedOrigins: ['https://imaging.example.edu'],
  });
  assert.ok(allowed.authorize('https://imaging.example.edu/bulk/1'));
  assert.equal(allowed.authorize('https://other.example.net/x'), null);
});

test('认证信息只发给授权来源，重定向逐跳重新判定且不携带凭据', async () => {
  const seen = [];
  const server = await listen(async (url, request) => {
    seen.push({ path: url.pathname, authorization: request.headers.authorization ?? null });
    if (url.pathname === '/redirect-external') {
      return { status: 302, headers: { location: 'https://imaging.example.edu/leak' }, body: '' };
    }
    if (url.pathname === '/redirect-internal') {
      return { status: 302, headers: { location: '/target' }, body: '' };
    }
    return { body: { ok: true } };
  });
  try {
    const policy = new FetchPolicy({
      source: server.url,
      credentials: new Map([[new URL(server.url).origin, 'Bearer secret']]),
    });
    const response = await policy.fetch(`${server.url}/target`);
    assert.equal(response.status, 200);
    assert.equal(seen.at(-1).authorization, 'Bearer secret');

    // 同源重定向：逐跳附加同源凭据
    const redirected = await policy.fetch(`${server.url}/redirect-internal`);
    assert.equal(redirected.status, 200);
    assert.deepEqual(seen.filter(item => item.path === '/target').map(item => item.authorization), ['Bearer secret', 'Bearer secret']);

    // 跨域重定向到未授权来源：拒绝，凭据不跟随
    await assert.rejects(policy.fetch(`${server.url}/redirect-external`), /授权清单/);
  } finally {
    await server.close();
  }
});

test('不同来源的凭据严格隔离', async () => {
  const server = await listen(async (url, request) => ({
    body: { authorization: request.headers.authorization ?? null },
  }));
  try {
    const policy = new FetchPolicy({
      source: server.url,
      allowedOrigins: ['https://imaging.example.edu'],
      credentials: new Map([['https://imaging.example.edu', 'Bearer outer']]),
    });
    // 回环来源未配置凭据，请求不得带上外域的令牌
    const response = await policy.fetch(`${server.url}/whoami`);
    assert.deepEqual(await response.json(), { authorization: null });
  } finally {
    await server.close();
  }
});
