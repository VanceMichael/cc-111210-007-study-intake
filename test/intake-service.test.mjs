import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from '../src/service.mjs';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'intake-service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory, stableRounds: 2 });
  return { directory, fixture, service };
}

async function teardown({ directory, fixture, service }) {
  await service.close();
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}

test('按检查轮询接收，封口前发布接口 409，封口后分层清单可见', async () => {
  const ctx = await setup();
  try {
    let response = await fetch(ctx.service.url + '/intake/poll?study=1');
    let job = await response.json();
    assert.equal(job.state, 'open');

    response = await fetch(ctx.service.url + '/intake/published?study=1');
    assert.equal(response.status, 409);
    assert.match(await response.text(), /不可见/);

    response = await fetch(ctx.service.url + '/intake/poll?study=1');
    job = await response.json();
    assert.equal(job.state, 'sealed');

    response = await fetch(ctx.service.url + '/intake/published?study=1');
    assert.equal(response.status, 200);
    const published = await response.json();
    assert.equal(published.studyUid, '1');
    assert.equal(published.series[0].seriesUid, '1.1');
    const instance = published.series[0].instances[0];
    assert.equal(instance.instanceUid, '1.1.1');
    assert.ok(instance.bulk[0].receipt.digest);
    assert.equal(instance.representations[0].frames.length, 2);

    // 已发布检查的资源字节可按分层 UID 取回
    const frame = await fetch(`${ctx.service.url}/intake/resource?study=1&series=1.1&instance=1.1.1&kind=frame&ts=1.2.840.10008.1.2.1&frame=1`);
    assert.equal(frame.status, 200);
    assert.deepEqual(Buffer.from(await frame.arrayBuffer()), Buffer.from('frame:1.1.1:1'));

    const list = await (await fetch(ctx.service.url + '/intake/published-list')).json();
    assert.deepEqual(list.published, ['1']);
  } finally { await teardown(ctx); }
});

test('run 接口轮询到封口，目录新增后形成第二版', async () => {
  const ctx = await setup();
  try {
    let response = await fetch(ctx.service.url + '/intake/run?study=1&maxRounds=5');
    let job = await response.json();
    assert.equal(job.state, 'sealed');
    assert.equal(job.manifest.manifestVersion, 1);

    await fetch(ctx.fixture.url + '/advance');
    response = await fetch(ctx.service.url + '/intake/run?study=1&maxRounds=5');
    job = await response.json();
    assert.equal(job.state, 'sealed');
    assert.equal(job.manifest.manifestVersion, 2);
    // 版次历史保留了目录新增记录；最终轮已稳定，summary 不再报告新增
    assert.deepEqual(job.history.at(-1).added, ['1.1.2']);
    assert.deepEqual(job.summary.added, []);
    assert.equal(job.incomplete.length, 0);
  } finally { await teardown(ctx); }
});

test('未建立作业查询返回 404，非法 UID 与资源参数被拒绝', async () => {
  const ctx = await setup();
  try {
    assert.equal((await fetch(ctx.service.url + '/intake/job?study=1')).status, 404);
    const bad = await fetch(ctx.service.url + '/intake/poll?study=../etc');
    assert.equal(bad.status, 400);
    await fetch(ctx.service.url + '/intake/poll?study=1');
    await fetch(ctx.service.url + '/intake/poll?study=1');
    const badTag = await fetch(ctx.service.url + '/intake/resource?study=1&series=1.1&instance=1.1.1&kind=bulk&tag=zz');
    assert.equal(badTag.status, 400);
  } finally { await teardown(ctx); }
});

test('既有单次查看与回执接口保持可用', async () => {
  const ctx = await setup();
  try {
    const inspect = await (await fetch(ctx.service.url + '/inspect')).json();
    assert.equal(inspect.count, 1);
    const receipt = await (await fetch(ctx.service.url + '/receive?key=legacy')).json();
    assert.ok(receipt.digest);
    const reread = await (await fetch(ctx.service.url + '/receipts/legacy')).json();
    assert.deepEqual(reread, receipt);
  } finally { await teardown(ctx); }
});
