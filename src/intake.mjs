import { IntakeStore, sha256 } from './intake-store.mjs';
import { bulkReferences, scalar } from './dweb.mjs';
import { assertUid } from './util.mjs';

const STUDY_UID_TAG = '0020000D';
const SERIES_UID_TAG = '0020000E';
const INSTANCE_UID_TAG = '00080018';
const NUMBER_OF_FRAMES_TAG = '00280008';

// 一次检查接收的编排：目录轮询、封口判定、版次差异、未完成清单、复用与单资源重取。
export class StudyIntake {
  constructor({ client, store, stableRounds = 2, transferSyntaxes = [null] }) {
    if (!(client && store)) throw new Error('StudyIntake 缺少 client 或 store');
    this.client = client;
    this.store = store;
    this.stableRounds = stableRounds;
    // null 表示不指定传输语法，接受网关选择；字符串表示按该传输语法请求一种表示
    this.transferSyntaxes = transferSyntaxes;
  }

  static async create(options) {
    const store = options.store ?? new IntakeStore(options.directory);
    await store.init();
    return new StudyIntake({ ...options, store });
  }

  // 轮询直到封口，或达到最大轮数；返回最终作业状态
  async run(studyUid, { maxRounds = 20, waitMs = 0 } = {}) {
    let job;
    for (let round = 0; round < maxRounds; round++) {
      job = await this.poll(studyUid);
      if (job.state === 'sealed') return job;
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    return job;
  }

  async poll(studyUid) {
    assertUid(studyUid, '检查');
    await this.store.init();
    const catalog = await this.client.fetchCatalog();
    const version = catalog.etag ?? `anon-${sha256(JSON.stringify(catalog.rows)).slice(0, 16)}`;
    const previous = await this.store.loadJob(studyUid);
    const now = new Date().toISOString();
    const job = previous ?? {
      studyUid,
      state: 'open',
      createdAt: now,
      rounds: 0,
      roundsStable: 0,
      catalogVersion: null,
      history: [],
      instances: {},
      publishedVersions: [],
    };

    const knownBefore = new Set(Object.keys(job.instances));
    const catalogUids = [];
    for (const row of catalog.rows) {
      const rowStudy = scalar(row, STUDY_UID_TAG);
      const seriesUid = scalar(row, SERIES_UID_TAG);
      const instanceUid = scalar(row, INSTANCE_UID_TAG);
      if (rowStudy !== studyUid) throw new Error(`目录中的检查 UID 与请求不一致: ${rowStudy}`);
      if (!seriesUid || !instanceUid) throw new Error('目录实例缺少序列或实例 UID');
      catalogUids.push(instanceUid);
      const frameCount = Number(scalar(row, NUMBER_OF_FRAMES_TAG) ?? 1);
      if (!Number.isInteger(frameCount) || frameCount < 1) throw new Error(`实例 ${instanceUid} 帧数值无效`);
      const bulks = [...bulkReferences(row)].map(ref => ({ ...ref }));
      if (!job.instances[instanceUid]) {
        job.instances[instanceUid] = {
          studyUid,
          instanceUid,
          seriesUid,
          frameCount,
          addedInVersion: version,
          discoveredAt: now,
          bulks: {},
          frames: {},
        };
      }
      const entry = job.instances[instanceUid];
      entry.seriesUid = seriesUid;
      entry.frameCount = frameCount;
      for (const ref of bulks) {
        if (!entry.bulks[ref.tag]) {
          entry.bulks[ref.tag] = {
            tag: ref.tag,
            vr: ref.vr,
            sourceUri: ref.uri,
            status: 'pending',
            attempts: [],
            receipt: null,
          };
        } else {
          entry.bulks[ref.tag].sourceUri = ref.uri;
        }
      }
    }

    const catalogSet = new Set(catalogUids);
    if (catalogUids.length !== catalogSet.size) throw new Error('目录中存在重复实例 UID');
    const added = catalogUids.filter(uid => !knownBefore.has(uid));
    const removed = [...knownBefore].filter(uid => !catalogSet.has(uid));
    // 实例从目录消失：保留已存字节与回执，但标记为未完成并记录版次差异，禁止封口
    for (const uid of removed) {
      const entry = job.instances[uid];
      entry.removedInVersion = version;
      for (const ref of Object.values(entry.bulks)) {
        if (ref.status === 'received') {
          ref.status = 'failed';
          ref.lastError = `实例已在目录版次 ${version} 中移除`;
        }
      }
      for (const representation of Object.values(entry.frames)) {
        for (const item of Object.values(representation.frames)) {
          if (item.status === 'received') {
            item.status = 'failed';
            item.lastError = `实例已在目录版次 ${version} 中移除`;
          }
        }
      }
    }
    const versionChanged = job.catalogVersion !== version;
    if (versionChanged) {
      job.roundsStable = 0;
      job.catalogVersion = version;
      job.lastVersionAt = now;
      if (!job.firstVersionAt) job.firstVersionAt = now;
      job.history.push({ version, seenAt: now, total: catalogUids.length, added, removed });
    } else if (job.rounds > 0) {
      // 仅当至少见过一次同一版次后，才累计稳定轮数（首轮不能直接封口）
      job.roundsStable += 1;
    }
    job.rounds += 1;
    job.lastPollAt = now;

    for (const instanceUid of catalogUids) {
      await this.reconcileInstance(job.instances[instanceUid]);
    }

    const incomplete = this.buildIncomplete(job);
    // 当前轮版次未变化且已经见过至少一版稳定轮次（stableRounds 默认 2），才允许封口
    const stableEnough = !versionChanged && job.roundsStable >= this.stableRounds - 1;
    const canSeal = catalogUids.length > 0 && incomplete.length === 0 &&
      (stableEnough || (this.stableRounds <= 1 && job.rounds >= 1));
    job.state = canSeal ? 'sealed' : 'open';
    job.incomplete = incomplete;
    job.summary = {
      catalogVersion: job.catalogVersion,
      instances: catalogUids.length,
      rounds: job.rounds,
      roundsStable: job.roundsStable,
      stableRoundsRequired: this.stableRounds,
      added,
      removed,
      incompleteCount: incomplete.length,
    };

    if (job.state === 'sealed') {
      const candidate = this.buildManifest(job, catalog.mediaType);
      const lastPublished = job.publishedVersions.at(-1);
      const contentChanged = !lastPublished ||
        lastPublished.catalogVersion !== job.catalogVersion ||
        lastPublished.digest !== candidate.manifestDigest;
      if (contentChanged) {
        const manifest = { ...candidate, manifestVersion: job.publishedVersions.length + 1 };
        const published = await this.store.publish(studyUid, manifest);
        job.manifest = manifest;
        job.publishedVersions.push({
          version: manifest.manifestVersion,
          catalogVersion: job.catalogVersion,
          digest: manifest.manifestDigest,
          publishedAt: published.publishedAt,
        });
      } else if (job.manifest) {
        // 已发布且内容未变：沿用既有版本号，不产生新版本
        job.manifest = { ...candidate, manifestVersion: lastPublished.version, sealedAt: job.manifest.sealedAt };
      }
    }
    await this.store.saveJob(job);
    return job;
  }

  async reconcileInstance(entry) {
    const { seriesUid, instanceUid } = entry;
    // 大字段：每个 BulkDataURI 独立领取，失败只重试该资源
    for (const ref of Object.values(entry.bulks)) {
      const path = this.store.bulkPath(entry.studyUid, seriesUid, instanceUid, ref.tag);
      await this.ensureBulk(entry, ref, path);
    }
    // 分帧：按传输表示分别领取，不同传输语法各自成目录
    const seenSyntaxes = new Set();
    for (const requestedSyntax of this.transferSyntaxes) {
      const representation = await this.ensureFrames(entry, requestedSyntax);
      // 两个请求表示被网关解析为同一实际传输语法时，只保留一份，避免互相覆盖
      if (seenSyntaxes.has(representation.transferSyntax)) continue;
      seenSyntaxes.add(representation.transferSyntax);
      entry.frames[representation.transferSyntax] = representation.record;
    }
  }

  async ensureBulk(entry, ref, path) {
    try {
      const existing = await this.store.verifyStored(path);
      if (existing) {
        ref.status = 'received';
        ref.receipt = existing.resource;
        ref.reused = true;
        return;
      }
    } catch (error) {
      // 本地校验失败：丢弃坏文件，按单资源重取
      ref.attempts.push({ at: new Date().toISOString(), stage: 'verify', error: error.message });
    }
    try {
      const fetched = await this.client.fetchBulk(ref.sourceUri);
      const receipt = await this.store.putResource(path, {
        kind: 'bulk',
        tag: ref.tag,
        sourceUri: ref.sourceUri,
        mediaType: fetched.mediaType,
        etag: fetched.etag,
        data: fetched.data,
      });
      ref.status = 'received';
      ref.receipt = receipt.resource;
      ref.reused = false;
      ref.lastError = null;
    } catch (error) {
      ref.status = 'failed';
      ref.lastError = error.message;
      ref.attempts.push({ at: new Date().toISOString(), stage: 'fetch', error: error.message });
      if (ref.attempts.length > 20) ref.attempts = ref.attempts.slice(-20);
    }
  }

  // 保证一个实例在某传输表示下的全部帧；批量请求失败则逐帧单独重取
  async ensureFrames(entry, requestedSyntax) {
    const key = requestedSyntax ?? '__default__';
    if (!entry._frameState) {
      Object.defineProperty(entry, '_frameState', { value: {}, enumerable: false, writable: true, configurable: true });
    }
    if (!entry._frameState[key]) {
      const persisted = entry.frames
        ? Object.values(entry.frames).find(representation => representation.requestedSyntax === requestedSyntax)
        : null;
      const frames = Object.fromEntries(Array.from({ length: entry.frameCount }, (_, index) => {
        const frame = index + 1;
        const prior = persisted?.frames?.[frame];
        return [frame, {
          frame,
          status: prior?.status === 'received' ? 'received' : 'pending',
          attempts: [],
          receipt: prior?.receipt ?? null,
          contentId: prior?.contentId ?? null,
        }];
      }));
      entry._frameState[key] = {
        requestedSyntax,
        transferSyntax: persisted?.transferSyntax ?? null,
        mediaType: persisted?.mediaType ?? null,
        frames,
      };
    }
    const state = entry._frameState[key];
    const studyUid = entry.studyUid;

    const missingFrames = () => Object.values(state.frames)
      .filter(item => item.status !== 'received')
      .map(item => item.frame);

    // 每轮都核对本地已存资源：完好则复用（不再请求网关），摘要损坏则降级为待重取
    for (const item of Object.values(state.frames)) {
      const syntaxForPath = state.transferSyntax ?? requestedSyntax;
      if (!syntaxForPath) continue; // 尚未拿到过响应，不知道实际传输语法，无法定位
      const path = this.store.framePath(studyUid, entry.seriesUid, entry.instanceUid, syntaxForPath, item.frame);
      let existing = null;
      try {
        existing = await this.store.verifyStored(path);
      } catch (error) {
        item.status = 'pending';
        item.receipt = null;
        item.reused = false;
        item.lastError = error.message;
        item.attempts.push({ at: new Date().toISOString(), stage: 'verify', error: error.message });
        continue;
      }
      if (existing) {
        item.status = 'received';
        item.receipt = existing.resource;
        item.reused = true;
      }
    }

    let pending = missingFrames();
    if (pending.length > 1) {
      try {
        const result = await this.client.fetchFrames(entry.instanceUid, pending, { transferSyntax: requestedSyntax });
        state.transferSyntax = result.transferSyntax;
        state.mediaType = result.mediaType;
        for (const frame of pending) {
          const part = result.frames.get(frame);
          const path = this.store.framePath(studyUid, entry.seriesUid, entry.instanceUid, result.transferSyntax, frame);
          const receipt = await this.store.putResource(path, {
            kind: 'frame',
            frame,
            sourceUri: `/instances/${entry.instanceUid}/frames/${frame}`,
            mediaType: part.mediaType,
            transferSyntax: result.transferSyntax,
            etag: null,
            data: part.data,
          });
          state.frames[frame].status = 'received';
          state.frames[frame].receipt = receipt.resource;
          state.frames[frame].contentId = part.contentId;
          state.frames[frame].reused = false;
        }
      } catch (error) {
        // 整批核对失败（如 Content-ID/帧号对不上）：拆成单帧请求，逐个核对重取
        for (const frame of pending) {
          state.frames[frame].attempts.push({ at: new Date().toISOString(), stage: 'batch', error: error.message });
        }
      }
    }

    pending = missingFrames();
    for (const frame of pending) {
      try {
        const result = await this.client.fetchFrames(entry.instanceUid, [frame], { transferSyntax: requestedSyntax });
        state.transferSyntax = result.transferSyntax;
        state.mediaType = result.mediaType;
        const part = result.frames.get(frame);
        const path = this.store.framePath(studyUid, entry.seriesUid, entry.instanceUid, result.transferSyntax, frame);
        const receipt = await this.store.putResource(path, {
          kind: 'frame',
          frame,
          sourceUri: `/instances/${entry.instanceUid}/frames/${frame}`,
          mediaType: part.mediaType,
          transferSyntax: result.transferSyntax,
          etag: null,
          data: part.data,
        });
        state.frames[frame].status = 'received';
        state.frames[frame].receipt = receipt.resource;
        state.frames[frame].contentId = part.contentId;
        state.frames[frame].reused = false;
        state.frames[frame].lastError = null;
      } catch (error) {
        state.frames[frame].status = 'failed';
        state.frames[frame].lastError = error.message;
        state.frames[frame].attempts.push({ at: new Date().toISOString(), stage: 'fetch', error: error.message });
        if (state.frames[frame].attempts.length > 20) {
          state.frames[frame].attempts = state.frames[frame].attempts.slice(-20);
        }
      }
    }

    // 输出可持久化的记录（不含临时字段）
    const record = {
      requestedSyntax,
      transferSyntax: state.transferSyntax,
      mediaType: state.mediaType,
      frames: Object.fromEntries(Object.entries(state.frames).map(([frame, item]) => [frame, {
        frame: item.frame,
        status: item.status,
        reused: item.reused ?? false,
        contentId: item.contentId ?? null,
        lastError: item.lastError ?? null,
        attempts: item.attempts.length,
        receipt: item.receipt,
      }])),
    };
    return { transferSyntax: state.transferSyntax ?? requestedSyntax ?? 'unknown', record };
  }

  buildIncomplete(job) {
    const incomplete = [];
    for (const entry of Object.values(job.instances)) {
      for (const ref of Object.values(entry.bulks)) {
        if (ref.status !== 'received') {
          incomplete.push({ instance: entry.instanceUid, kind: 'bulk', tag: ref.tag, reason: ref.lastError ?? '尚未接收' });
        }
      }
      for (const [syntax, representation] of Object.entries(entry.frames)) {
        for (const item of Object.values(representation.frames)) {
          if (item.status !== 'received') {
            incomplete.push({
              instance: entry.instanceUid,
              kind: 'frame',
              frame: item.frame,
              transferSyntax: syntax,
              reason: item.lastError ?? '尚未接收',
            });
          }
        }
      }
    }
    return incomplete;
  }

  // 分层清单：检查 -> 序列 -> 实例 -> 大字段/分帧（分帧再按传输表示分组）
  buildManifest(job, catalogMediaType) {
    // 摘要只取自资源的稳定字段（定位、媒体类型、传输语法、字节摘要），
    // 不含 storedAt、status、reused 等易失字段，因此同一版次重复轮询得到相同摘要。
    const stableReceipt = receipt => receipt && {
      kind: receipt.kind,
      tag: receipt.tag,
      frame: receipt.frame,
      transferSyntax: receipt.transferSyntax,
      mediaType: receipt.mediaType,
      sourceUri: receipt.sourceUri,
      etag: receipt.etag,
      size: receipt.size,
      digest: receipt.digest,
    };
    const seriesMap = new Map();
    const stableResources = [];
    for (const entry of Object.values(job.instances)) {
      if (!seriesMap.has(entry.seriesUid)) seriesMap.set(entry.seriesUid, { seriesUid: entry.seriesUid, instances: [] });
      const bulk = Object.values(entry.bulks).map(ref => {
        const stable = stableReceipt(ref.receipt);
        if (stable) stableResources.push(stable);
        return {
          tag: ref.tag,
          vr: ref.vr,
          sourceUri: ref.sourceUri,
          status: ref.status,
          receipt: stable,
        };
      });
      const representations = Object.values(entry.frames).map(representation => {
        const frames = Object.values(representation.frames).map(item => {
          const stable = stableReceipt(item.receipt);
          if (stable) stableResources.push(stable);
          return {
            frame: item.frame,
            contentId: item.contentId ?? null,
            status: item.status,
            receipt: stable,
          };
        });
        return {
          requestedSyntax: representation.requestedSyntax,
          transferSyntax: representation.transferSyntax,
          mediaType: representation.mediaType,
          frames,
        };
      });
      seriesMap.get(entry.seriesUid).instances.push({
        instanceUid: entry.instanceUid,
        frameCount: entry.frameCount,
        addedInVersion: entry.addedInVersion,
        bulk,
        representations,
      });
    }
    // 稳定投影：仅含决定资料版本的字段，顺序固定
    const projection = {
      studyUid: job.studyUid,
      catalogVersion: job.catalogVersion,
      catalogMediaType,
      series: [...seriesMap.values()],
      resources: stableResources.map(item => JSON.stringify(item)).sort(),
    };
    const body = {
      ...projection,
      state: 'sealed',
      resourceCount: stableResources.length,
      resourcesDigest: sha256(projection.resources.join('\n')),
    };
    // manifestDigest 覆盖全部稳定内容；版本号与时间戳放在摘要之外
    return {
      ...body,
      manifestVersion: null, // 由调用方在发布时按发布历史编号
      sealedAt: new Date().toISOString(),
      manifestDigest: sha256(JSON.stringify(projection)),
    };
  }
}
