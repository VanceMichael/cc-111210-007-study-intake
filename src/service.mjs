import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { ReceiptStore } from './store.mjs';
import { readFile } from 'node:fs/promises';
import { FetchPolicy } from './policy.mjs';
import { DICOMwebClient } from './dweb.mjs';
import { StudyIntake } from './intake.mjs';
import { IntakeStore } from './intake-store.mjs';
import { assertUid } from './util.mjs';

const DEFAULT_STUDY = '1';

function buildDeps(source, { directory, policy, allowedOrigins, credentials, stableRounds, transferSyntaxes }) {
  const fetchPolicy = policy ?? new FetchPolicy({
    source,
    allowedOrigins: allowedOrigins ?? [],
    credentials: credentials ?? new Map(),
  });
  const client = new DICOMwebClient({ policy: fetchPolicy });
  const intakeStore = new IntakeStore(directory);
  const intake = new StudyIntake({ client, store: intakeStore, stableRounds: stableRounds ?? 2, transferSyntaxes });
  return { fetchPolicy, client, intakeStore, intake };
}

export async function startService({
  source,
  directory,
  port = 0,
  policy,
  allowedOrigins,
  credentials,
  stableRounds,
  transferSyntaxes = [null],
}) {
  const receiptStore = new ReceiptStore(directory);
  const deps = buildDeps(source, { directory, policy, allowedOrigins, credentials, stableRounds, transferSyntaxes });

  return listen(async (url, request) => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };

    // —— 兼容既有单次查看接口 ——
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await receiptStore.save(key, result) };
    }
    if (url.pathname.startsWith('/receipts/')) {
      return { body: await receiptStore.read(url.pathname.split('/').pop()) };
    }

    // —— 按检查接收资料 ——
    if (url.pathname === '/intake/poll') {
      const studyUid = url.searchParams.get('study') ?? DEFAULT_STUDY;
      assertUid(studyUid, '检查');
      const job = await deps.intake.poll(studyUid);
      return { body: job };
    }
    if (url.pathname === '/intake/run') {
      const studyUid = url.searchParams.get('study') ?? DEFAULT_STUDY;
      assertUid(studyUid, '检查');
      const maxRounds = Number(url.searchParams.get('maxRounds') ?? 10);
      const waitMs = Number(url.searchParams.get('waitMs') ?? 0);
      const job = await deps.intake.run(studyUid, { maxRounds, waitMs });
      return { body: job };
    }
    if (url.pathname === '/intake/job') {
      const studyUid = url.searchParams.get('study') ?? DEFAULT_STUDY;
      assertUid(studyUid, '检查');
      const job = await deps.intakeStore.loadJob(studyUid);
      if (!job) return { status: 404, body: { error: '该检查尚无接收作业' } };
      return { body: job };
    }
    if (url.pathname === '/intake/published') {
      const studyUid = url.searchParams.get('study') ?? DEFAULT_STUDY;
      assertUid(studyUid, '检查');
      const published = await deps.intakeStore.readPublished(studyUid);
      if (!published) return { status: 409, body: { error: '检查尚未封口，讨论区不可见', study: studyUid } };
      return { body: published };
    }
    if (url.pathname === '/intake/published-list') {
      const names = await deps.intakeStore.listPublished();
      return { body: { published: names.map(name => name.replace(/\.json$/, '')) } };
    }
    if (url.pathname === '/intake/resource') {
      // 仅回送已发布检查内的资源字节，路径由分层 UID 约束，不接受任意 URL
      const studyUid = url.searchParams.get('study') ?? DEFAULT_STUDY;
      const seriesUid = url.searchParams.get('series');
      const instanceUid = url.searchParams.get('instance');
      const kind = url.searchParams.get('kind');
      assertUid(studyUid, '检查');
      assertUid(seriesUid, '序列');
      assertUid(instanceUid, '实例');
      const published = await deps.intakeStore.readPublished(studyUid);
      if (!published) return { status: 409, body: { error: '检查尚未封口，资源不可见' } };
      // 二次确认：请求的资源必须出现在已发布清单中，不允许读取清单外的文件
      const series = published.series.find(item => item.seriesUid === seriesUid);
      const instance = series?.instances.find(item => item.instanceUid === instanceUid);
      if (!instance) return { status: 404, body: { error: '资源不在已发布清单中' } };
      let resourcePath;
      if (kind === 'bulk') {
        const tag = url.searchParams.get('tag');
        if (!/^[0-9A-Fa-f]{8}$/.test(tag ?? '')) return { status: 400, body: { error: '标签无效' } };
        resourcePath = deps.intakeStore.bulkPath(studyUid, seriesUid, instanceUid, tag);
      } else if (kind === 'frame') {
        const transferSyntax = url.searchParams.get('ts');
        const frame = Number(url.searchParams.get('frame'));
        assertUid(transferSyntax, '传输语法');
        if (!Number.isInteger(frame) || frame < 1) return { status: 400, body: { error: '帧号无效' } };
        resourcePath = deps.intakeStore.framePath(studyUid, seriesUid, instanceUid, transferSyntax, frame);
      } else {
        return { status: 400, body: { error: '资源类型无效' } };
      }
      const bytes = await readFile(resourcePath);
      return { type: 'application/octet-stream', body: bytes, headers: { 'x-study': studyUid } };
    }

    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}

export { buildDeps };
