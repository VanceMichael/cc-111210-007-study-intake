import { startService } from './service.mjs';
import { startFixture } from '../fixtures/source.mjs';

const fixture = process.env.SOURCE_URL
  ? { url: process.env.SOURCE_URL, close: async () => {} }
  : await startFixture();

// 外域授权清单与凭据由部署配置给出；演练默认只访问回环来源
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(item => item.trim()).filter(Boolean)
  : [];
const credentials = new Map();
if (process.env.SOURCE_TOKEN) credentials.set(new URL(fixture.url).origin, `Bearer ${process.env.SOURCE_TOKEN}`);
if (process.env.ALLOWED_TOKENS) {
  for (const pair of process.env.ALLOWED_TOKENS.split(',').map(item => item.trim()).filter(Boolean)) {
    const separator = pair.indexOf('|');
    if (separator < 0) throw new Error('ALLOWED_TOKENS 格式应为 来源|令牌');
    credentials.set(new URL(pair.slice(0, separator)).origin, pair.slice(separator + 1));
  }
}
const transferSyntaxes = process.env.TRANSFER_SYNTAXES
  ? process.env.TRANSFER_SYNTAXES.split(',').map(item => item.trim()).filter(Boolean).map(item => (item === 'default' ? null : item))
  : [null];

const service = await startService({
  source: fixture.url,
  directory: process.env.DATA_DIR ?? '/tmp/capture-receipts',
  port: Number(process.env.PORT ?? 3000),
  allowedOrigins,
  credentials,
  transferSyntaxes,
  stableRounds: Number(process.env.STABLE_ROUNDS ?? 2),
});
console.log(JSON.stringify({ service: service.url, source: fixture.url, allowedOrigins, transferSyntaxes }));
const close = async () => { await service.close(); await fixture.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
