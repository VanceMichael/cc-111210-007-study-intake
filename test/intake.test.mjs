import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { FetchPolicy } from '../src/policy.mjs';
import { DICOMwebClient, bulkReferences } from '../src/dweb.mjs';
import { StudyIntake } from '../src/intake.mjs';
import { IntakeStore } from '../src/intake-store.mjs';
import { parseMultipart, verifyFrameParts } from '../src/multipart.mjs';

const TS_DEFAULT = '1.2.840.10008.1.2.1';
const TS_RLE = '1.2.840.10008.1.2.5';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'intake-'));
  const source = await startFixture();
  const client = new DICOMwebClient({ policy: new FetchPolicy({ source: source.url }) });
  const intake = await StudyIntake.create({ client, directory, stableRounds: 2 });
  return { directory, source, client, intake, store: intake.store };
}

async function teardown({ directory, source }) {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}

test('封口判定：首轮不封口，连续稳定轮次后才发布且未封口不可见', async () => {
  const ctx = await setup();
  try {
    let job = await ctx.intake.poll('1');
    assert.equal(job.state, 'open');
    assert.equal(job.roundsStable, 0);
    assert.equal(await ctx.store.readPublished('1'), null);
    job = await ctx.intake.poll('1');
    assert.equal(job.state, 'sealed');
    assert.equal(job.roundsStable, 1);
    const published = await ctx.store.readPublished('1');
    assert.equal(published.state, 'sealed');
    assert.equal(published.manifestVersion, 1);
    // 重复轮询不产生新版本
    const again = await ctx.intake.poll('1');
    assert.equal(again.publishedVersions.length, 1);
    assert.equal(again.manifest.manifestVersion, 1);
  } finally { await teardown(ctx); }
});

test('目录增长产生版次差异，新实例完整前作业回到未完成清单', async () => {
  const ctx = await setup();
  try {
    await ctx.intake.poll('1');
    await ctx.intake.poll('1'); // 封口 v1
    await fetch(ctx.source.url + '/advance');
    const job = await ctx.intake.poll('1');
    assert.equal(job.state, 'open');
    assert.deepEqual(job.summary.added, ['1.1.2']);
    assert.equal(job.catalogVersion, '"study-2"');
    assert.equal(job.history.length, 2);
    // 同一轮内新实例也已领取完成，但稳定轮数清零，需再观察一轮
    assert.equal(job.incomplete.length, 0);
    const sealed = await ctx.intake.poll('1');
    assert.equal(sealed.state, 'sealed');
    assert.equal(sealed.manifest.manifestVersion, 2);
    const published = await ctx.store.readPublished('1');
    const instanceUids = published.series.flatMap(series => series.instances.map(item => item.instanceUid));
    assert.deepEqual(instanceUids.sort(), ['1.1.1', '1.1.2']);
  } finally { await teardown(ctx); }
});

test('检查/序列/实例分层落盘，大字段与分帧归属各自实例且按传输表示隔离', async () => {
  const ctx = await setup();
  try {
    await ctx.intake.poll('1');
    const base = join(ctx.directory, 'studies', '1', '1.1', '1.1.1');
    const tree = async root => (await readdir(root, { recursive: true })).sort();
    const files = await tree(base);
    assert.ok(files.includes(join('bulk', '7FE00010.bin')));
    assert.ok(files.includes(join('frames', TS_DEFAULT, 'frame-1.bin')));
    assert.ok(files.includes(join('frames', TS_DEFAULT, 'frame-2.bin')));
    for (const name of files) {
      if (name.endsWith('.bin')) assert.ok(files.includes(name + '.receipt.json'), `${name} 缺少回执`);
    }
    // 乱序帧仍按帧号正确归位
    assert.deepEqual(await readFile(join(base, 'frames', TS_DEFAULT, 'frame-1.bin')), Buffer.from('frame:1.1.1:1'));
    assert.deepEqual(await readFile(join(base, 'frames', TS_DEFAULT, 'frame-2.bin')), Buffer.from('frame:1.1.1:2'));
  } finally { await teardown(ctx); }
});

test('完整接收的实例跨作业复用，网络请求不再重复', async () => {
  const ctx = await setup();
  try {
    await ctx.intake.poll('1');
    await ctx.intake.poll('1');
    await fetch(ctx.source.url + '/stats/reset', { method: 'POST' });
    // 用新的 intake 实例模拟进程重启，复用同一目录
    const restarted = new StudyIntake({ client: ctx.client, store: ctx.store, stableRounds: 2 });
    const job = await restarted.poll('1');
    const stats = await (await fetch(ctx.source.url + '/stats')).json();
    assert.equal(stats.bulk['/bulk/1.1.1'], undefined);
    assert.equal(stats.frames['1.1.1:1,2'], undefined);
    const frame = job.instances['1.1.1'].frames[TS_DEFAULT].frames['1'];
    assert.equal(frame.status, 'received');
    assert.equal(frame.reused, true);
    assert.ok(frame.receipt.digest);
  } finally { await teardown(ctx); }
});

test('本地校验失败的资源单独重取，不影响其他已接收资源', async () => {
  const ctx = await setup();
  try {
    await ctx.intake.poll('1');
    await ctx.intake.poll('1');
    const framePath = ctx.store.framePath('1', '1.1', '1.1.1', TS_DEFAULT, 2);
    const bytes = Buffer.from(await readFile(framePath));
    bytes[0] ^= 0xff;
    await writeFile(framePath, bytes);
    await fetch(ctx.source.url + '/stats/reset', { method: 'POST' });
    const recovering = await ctx.intake.poll('1');
    const item = recovering.instances['1.1.1'].frames[TS_DEFAULT].frames['2'];
    assert.equal(item.status, 'received');
    assert.equal(item.attempts, 1);
    const stats = await (await fetch(ctx.source.url + '/stats')).json();
    assert.deepEqual(Object.keys(stats.frames), ['1.1.1:2']); // 只重取损坏的那一帧
    assert.equal(stats.bulk['/bulk/1.1.1'], undefined);
  } finally { await teardown(ctx); }
});

test('网关故障注入使未完成清单包含具体资源，解除后重新封口', async () => {
  const ctx = await setup();
  try {
    await fetch(`${ctx.source.url}/flaky?key=bulk:/bulk/1.1.1`, { method: 'POST' });
    const job = await ctx.intake.poll('1');
    assert.equal(job.state, 'open');
    assert.equal(job.incomplete[0].kind, 'bulk');
    assert.equal(job.incomplete[0].tag, '7FE00010');
    assert.match(job.incomplete[0].reason, /500/);
    // 解除故障，后续轮次重取成功并封口
    await fetch(`${ctx.source.url}/flaky?key=bulk:/bulk/1.1.1`, { method: 'POST' });
    const recovered = await ctx.intake.run('1', { maxRounds: 4 });
    assert.equal(recovered.state, 'sealed');
    assert.equal(recovered.incomplete.length, 0);
  } finally { await teardown(ctx); }
});

test('传输表示变化：新增 RLE 表示与默认表示分别存储，默认表示继续复用', async () => {
  const ctx = await setup();
  try {
    await ctx.intake.poll('1');
    await ctx.intake.poll('1');
    const rleIntake = new StudyIntake({
      client: ctx.client, store: ctx.store, stableRounds: 2,
      transferSyntaxes: [null, TS_RLE],
    });
    await fetch(ctx.source.url + '/stats/reset', { method: 'POST' });
    const job = await rleIntake.poll('1');
    const representations = Object.keys(job.instances['1.1.1'].frames).sort();
    assert.deepEqual(representations, [TS_DEFAULT, TS_RLE]);
    const rleFile = ctx.store.framePath('1', '1.1', '1.1.1', TS_RLE, 1);
    assert.deepEqual(await readFile(rleFile), Buffer.from('rle:1.1.1:1'));
    const stats = await (await fetch(ctx.source.url + '/stats')).json();
    // 默认表示复用本地文件，只请求了 RLE 一种新表示
    assert.ok(stats.frames['1.1.1:1,2']);
    const sealed = await rleIntake.poll('1');
    assert.equal(sealed.state, 'sealed');
    const repCount = sealed.manifest.series[0].instances[0].representations.length;
    assert.equal(repCount, 2);
  } finally { await teardown(ctx); }
});

test('分帧 multipart 的 Content-ID、媒体类型、帧号与请求对应关系被严格核对', async () => {
  const ctx = await setup();
  try {
    const response = await ctx.client.request('/instances/1.1.1/frames/1,2', {
      accept: 'application/octet-stream',
    });
    const parts = parseMultipart(response.headers.get('content-type'), Buffer.from(await response.arrayBuffer()));
    const result = verifyFrameParts({
      parts,
      requestUrl: new URL('/instances/1.1.1/frames/1,2', ctx.source.url).href,
      requestedFrames: [1, 2],
      acceptedMediaTypes: ['application/octet-stream'],
    });
    assert.equal(result.get(1).contentId, 'frame-1');
    assert.equal(result.get(2).transferSyntax, TS_DEFAULT);
    // 请求 RLE 时网关必须返回 RLE，不允许与默认表示混淆
    const rle = await ctx.client.fetchFrames('1.1.1', [1, 2], { transferSyntax: TS_RLE });
    assert.equal(rle.transferSyntax, TS_RLE);
    assert.deepEqual(rle.frames.get(1).data, Buffer.from('rle:1.1.1:1'));
  } finally { await teardown(ctx); }
});

test('外域 BulkDataURI 在未授权时拒绝，授权清单内来源才放行', async () => {
  const ctx = await setup();
  try {
    const catalog = await ctx.client.fetchCatalog();
    // 演练源通过 external=1 给出绝对外域 URI
    const externalResponse = await ctx.client.request('/studies/1/instances?external=1');
    const rows = await externalResponse.json();
    const ref = [...bulkReferences(rows[0])][0];
    assert.match(ref.uri, /^https:\/\//);
    await assert.rejects(ctx.client.fetchBulk(ref.uri), /授权清单/);
    const allowedClient = new DICOMwebClient({
      policy: new FetchPolicy({ source: ctx.source.url, allowedOrigins: ['https://imaging.example.edu'] }),
    });
    await assert.rejects(allowedClient.fetchBulk(ref.uri), /ENOTFOUND|getaddrinfo|fetch failed/);
    assert.ok(catalog.etag);
  } finally { await teardown(ctx); }
});

test('整批分帧失败后拆成单帧核对重取，故障帧单独留在未完成清单', async () => {
  const ctx = await setup();
  try {
    // 仅帧 2 故障：批量请求 500，拆单帧后帧 1 成功、帧 2 失败
    await fetch(`${ctx.source.url}/flaky?key=frame:1.1.1:2:${TS_DEFAULT}`, { method: 'POST' });
    const job = await ctx.intake.poll('1');
    assert.equal(job.state, 'open');
    assert.deepEqual(job.incomplete.map(item => item.frame), [2]);
    const representation = job.instances['1.1.1'].frames[TS_DEFAULT];
    assert.equal(representation.frames['1'].status, 'received');
    assert.equal(representation.frames['2'].status, 'failed');
    assert.match(representation.frames['2'].lastError, /500/);
    const stats = await (await fetch(ctx.source.url + '/stats')).json();
    // 一次批量尝试（500）+ 两次单帧尝试（帧 1 成功、帧 2 失败），尝试都计入来源统计
    assert.equal(stats.frames['1.1.1:1,2'], 1);
    assert.equal(stats.frames['1.1.1:1'], 1);
    assert.equal(stats.frames['1.1.1:2'], 1);
    // 解除故障后只需补帧 2
    await fetch(`${ctx.source.url}/flaky?key=frame:1.1.1:2:${TS_DEFAULT}`, { method: 'POST' });
    const recovered = await ctx.intake.run('1', { maxRounds: 4 });
    assert.equal(recovered.state, 'sealed');
  } finally { await teardown(ctx); }
});

test('作业状态持久化，未完成清单与版次历史可在重启后读取', async () => {
  const ctx = await setup();
  try {
    await fetch(`${ctx.source.url}/flaky?key=bulk:/bulk/1.1.1`, { method: 'POST' });
    await ctx.intake.poll('1');
    const reloaded = await ctx.store.loadJob('1');
    assert.equal(reloaded.studyUid, '1');
    assert.equal(reloaded.state, 'open');
    assert.ok(Array.isArray(reloaded.incomplete));
    assert.ok(reloaded.history[0].version);
  } finally { await teardown(ctx); }
});

test('实例从目录移除时记录版次差异并保持未封口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-remove-'));
  const row = (id, frameCount = 1) => ({
    '0020000D': { vr: 'UI', Value: ['9.9'] },
    '0020000E': { vr: 'UI', Value: ['9.9.8'] },
    '00080018': { vr: 'UI', Value: [id] },
    '00280008': { vr: 'IS', Value: [frameCount] },
    '7FE00010': { vr: 'OB', BulkDataURI: `/bulk/${id}` },
  });
  const catalogs = [
    { rows: [row('9.9.1')], etag: '"v1"', mediaType: 'application/dicom+json' },
    { rows: [], etag: '"v2"', mediaType: 'application/dicom+json' },
  ];
  const stubClient = {
    fetchCatalog: async () => catalogs.shift(),
    fetchBulk: async () => ({ data: Buffer.from('xyz'), mediaType: 'application/octet-stream', etag: '"b"' }),
    fetchFrames: async (instanceUid, frames) => {
      const TS = '1.2.840.10008.1.2.1';
      return {
        mediaType: 'application/octet-stream',
        transferSyntax: TS,
        frames: new Map(frames.map(frame => [frame, {
          contentId: `frame-${frame}`, mediaType: 'application/octet-stream', transferSyntax: TS, data: Buffer.from(`f${frame}`),
        }])),
      };
    },
  };
  try {
    const store = new IntakeStore(directory);
    const intake = new StudyIntake({ client: stubClient, store, stableRounds: 1 });
    let job = await intake.poll('9.9'); // stableRounds=1：首轮即封口
    assert.equal(job.state, 'sealed');
    job = await intake.poll('9.9'); // 目录清空，版次变化且实例移除
    assert.equal(job.state, 'open');
    assert.deepEqual(job.summary.removed, ['9.9.1']);
    assert.equal(job.incomplete[0].instance, '9.9.1');
    assert.match(job.incomplete[0].reason, /移除/);
    const published = await store.readPublished('9.9');
    assert.equal(published.state, 'sealed'); // 旧版本仍可见，未封口新版本不覆盖
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
