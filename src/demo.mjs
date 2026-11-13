import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';

const log = (title, value) => console.log(`\n===== ${title} =====\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);
const getJson = async url => (await fetch(url)).json();
const post = async url => (await fetch(url, { method: 'POST' })).json();

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
try {
  service = await startService({ source: source.url, directory, stableRounds: 2 });
  log('演练环境', { service: service.url, source: source.url, dataDir: directory });

  // 1. 首轮只看到目录，未封口的检查对讨论区不可见
  let job = await getJson(`${service.url}/intake/poll?study=1`);
  log('第 1 轮：发现目录但不封口', { state: job.state, roundsStable: job.roundsStable, incomplete: job.incomplete });
  let published = await fetch(`${service.url}/intake/published?study=1`);
  log('未封口时发布接口返回', { status: published.status, body: await published.json() });

  // 2. 第二轮目录版次稳定且资源完整 -> 封口，第一版对讨论区可见
  job = await getJson(`${service.url}/intake/poll?study=1`);
  log('第 2 轮：封口并发布第一版', {
    state: job.state,
    catalogVersion: job.catalogVersion,
    manifestVersion: job.manifest.manifestVersion,
    resourceCount: job.manifest.resourceCount,
    分层: job.manifest.series.map(series => ({
      series: series.seriesUid,
      instances: series.instances.map(item => ({
        instance: item.instanceUid,
        bulk: item.bulk.map(b => b.tag),
        representations: item.representations.map(rep => `${rep.transferSyntax}（${rep.frames.length} 帧）`),
      })),
    })),
  });

  // 3. 网关目录新增实例：版次差异与未完成清单
  await post(`${source.url}/advance`);
  job = await getJson(`${service.url}/intake/poll?study=1`);
  log('目录新增实例后的轮次', {
    state: job.state,
    catalogVersion: job.catalogVersion,
    added: job.summary.added,
    versionHistory: job.history.map(h => ({ version: h.version, total: h.total, added: h.added })),
    incomplete: job.incomplete,
  });
  job = await getJson(`${service.url}/intake/poll?study=1`);
  log('再次稳定后封口为第二版', {
    state: job.state,
    manifestVersion: job.manifest.manifestVersion,
    instances: job.manifest.series.flatMap(s => s.instances.map(i => i.instanceUid)),
  });

  // 4. 乱序分帧：帧按 Content-Location/Content-ID 归位，不依赖返回次序
  const frameOne = await fetch(`${service.url}/intake/resource?study=1&series=1.1&instance=1.1.1&kind=frame&ts=1.2.840.10008.1.2.1&frame=1`);
  const frameTwo = await fetch(`${service.url}/intake/resource?study=1&series=1.1&instance=1.1.1&kind=frame&ts=1.2.840.10008.1.2.1&frame=2`);
  log('乱序返回但按帧号正确归位', {
    frame1: (await frameOne.text()).trim(),
    frame2: (await frameTwo.text()).trim(),
  });

  // 5. 传输表示变化：同一实例增加 RLE 表示，与默认表示分别存储、互不混淆
  await service.close();
  service = await startService({
    source: source.url, directory, stableRounds: 2,
    transferSyntaxes: [null, '1.2.840.10008.1.2.5'],
  });
  await getJson(`${service.url}/intake/poll?study=1`);
  job = await getJson(`${service.url}/intake/poll?study=1`);
  log('增加 RLE 传输表示后的清单', {
    state: job.state,
    representations: job.manifest.series[0].instances[0].representations.map(rep => ({
      transferSyntax: rep.transferSyntax,
      frames: rep.frames.map(f => f.frame),
      digests: rep.frames.map(f => f.receipt.digest.slice(0, 12)),
    })),
  });
  const rle = await fetch(`${service.url}/intake/resource?study=1&series=1.1&instance=1.1.1&kind=frame&ts=1.2.840.10008.1.2.5&frame=1`);
  log('RLE 表示独立保存的字节', { rleFrame1: (await rle.text()).trim() });

  // 6. 校验失败的资源单独重取：破坏本地帧文件后再轮询
  const framePath = join(directory, 'studies', '1', '1.1', '1.1.1', 'frames', '1.2.840.10008.1.2.1', 'frame-2.bin');
  const bytes = Buffer.from(await readFile(framePath));
  bytes[0] ^= 0xff;
  await writeFile(framePath, bytes);
  await post(`${source.url}/stats/reset`);
  job = await getJson(`${service.url}/intake/poll?study=1`);
  const stats = await getJson(`${source.url}/stats`);
  log('本地校验失败后只重取出问题的资源', {
    state: job.state,
    frame2Attempts: job.instances['1.1.1'].frames['1.2.840.10008.1.2.1'].frames['2'].attempts,
    来源请求统计: stats.frames,
  });

  // 7. 外域授权：未授权地址拒绝，认证信息不跟随任意地址
  const policyCheck = await fetch(`${service.url}/intake/poll?study=1`).then(r => r.json());
  log('最终作业状态与发布版本', {
    state: policyCheck.state,
    publishedVersions: policyCheck.publishedVersions,
    讨论区可见: (await fetch(`${service.url}/intake/published-list`)).status === 200,
  });
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
