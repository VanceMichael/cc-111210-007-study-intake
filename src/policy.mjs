// 外域资源授权清单与凭据边界。
// 规则：
//  - 来源同源与回环地址默认可访问；其他外域必须出现在显式授权清单中。
//  - 认证信息（Authorization）只发给授权来源；发生跨域重定向时凭据不跟随，逐跳重新判定。
//  - 只允许 http/https，拒绝任何其他 scheme。
export class FetchPolicy {
  constructor({ source, allowedOrigins = [], credentials = new Map(), timeoutMs = 5000 } = {}) {
    this.sourceOrigin = new URL(source).origin;
    this.allowed = new Set([this.sourceOrigin, ...allowedOrigins.map(item => new URL(item).origin)]);
    this.credentials = new Map([...credentials].map(([origin, token]) => [new URL(origin).origin, token]));
    this.timeoutMs = timeoutMs;
    for (const origin of this.allowed) {
      const { protocol } = new URL(origin);
      if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`授权来源协议不允许: ${origin}`);
    }
  }

  isLoopback(url) {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  }

  // 返回允许携带凭据的来源；未授权返回 null
  authorize(rawUrl) {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (this.allowed.has(url.origin)) return url.origin;
    // 演练客户端仍只允许回环地址；生产来源的同源与显式清单才是外域白名单
    if (this.isLoopback(url)) return url.origin;
    return null;
  }

  assertAuthorized(rawUrl) {
    const origin = this.authorize(rawUrl);
    if (!origin) throw new Error(`外域资源不在授权清单中，拒绝访问: ${new URL(rawUrl).origin}`);
    return origin;
  }

  // 带授权清单约束的请求：手动跟随重定向，逐跳核对目标、逐跳附加凭据
  async fetch(rawUrl, { method = 'GET', headers = {}, redirect = 'follow' } = {}) {
    let current = new URL(rawUrl);
    let hops = 0;
    for (;;) {
      const origin = this.assertAuthorized(current.href);
      const finalHeaders = { ...headers };
      const token = this.credentials.get(origin);
      // 只有当该来源在授权清单中配置了凭据时才发送 Authorization，绝不沿用其他来源的凭据
      if (token) finalHeaders.authorization = token;
      const response = await fetch(current, {
        method,
        headers: finalHeaders,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (redirect === 'error' || ++hops > 5) throw new Error('重定向次数过多或被禁止');
        current = new URL(response.headers.get('location'), current);
        continue;
      }
      return response;
    }
  }
}
