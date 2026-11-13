import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertUid, digest, safeMediaType } from './util.mjs';

export function sha256(bytes) { return digest(bytes); }

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temporary, path);
}

// 按 检查/序列/实例 分层落盘；大字段与分帧资源归属各自的实例，
// 分帧再按传输语法分目录，不同传输表示不会混成同一份。
export class IntakeStore {
  constructor(directory) {
    this.directory = directory;
    this.studiesRoot = join(directory, 'studies');
    this.jobsRoot = join(directory, 'jobs');
    this.publishedRoot = join(directory, 'published');
  }

  async init() {
    for (const root of [this.studiesRoot, this.jobsRoot, this.publishedRoot]) {
      await mkdir(root, { recursive: true });
    }
  }

  instanceDir(studyUid, seriesUid, instanceUid) {
    assertUid(studyUid, '检查');
    assertUid(seriesUid, '序列');
    assertUid(instanceUid, '实例');
    return join(this.studiesRoot, studyUid, seriesUid, instanceUid);
  }

  bulkPath(studyUid, seriesUid, instanceUid, tag) {
    if (!/^[0-9A-Fa-f]{8}$/.test(tag)) throw new Error(`DICOM 标签无效: ${tag}`);
    return join(this.instanceDir(studyUid, seriesUid, instanceUid), 'bulk', `${tag}.bin`);
  }

  framePath(studyUid, seriesUid, instanceUid, transferSyntax, frame) {
    assertUid(transferSyntax, '传输语法');
    if (!Number.isInteger(frame) || frame < 1) throw new Error('帧号必须是正整数');
    return join(
      this.instanceDir(studyUid, seriesUid, instanceUid),
      'frames',
      transferSyntax,
      `frame-${frame}.bin`,
    );
  }

  receiptPathFor(resourcePath) {
    return `${resourcePath}.receipt.json`;
  }

  // 读取已存资源回执；文件或回执缺失、摘要不符都视为不可复用
  async readResourceReceipt(resourcePath) {
    try {
      const receipt = await readJson(this.receiptPathFor(resourcePath));
      if (digest(JSON.stringify(receipt.resource)) !== receipt.receiptDigest) throw new Error('回执自校验失败');
      return receipt;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  // 写入资源及其回执（临时文件 + 原子改名），返回规范化回执
  async putResource(resourcePath, resource) {
    await mkdir(join(resourcePath, '..'), { recursive: true });
    const temporary = `${resourcePath}.${randomUUID()}`;
    await writeFile(temporary, resource.data, { flag: 'wx' });
    await rename(temporary, resourcePath);
    const stored = {
      kind: resource.kind,
      mediaType: safeMediaType(resource.mediaType),
      transferSyntax: resource.transferSyntax ?? null,
      frame: resource.frame ?? null,
      tag: resource.tag ?? null,
      sourceUri: resource.sourceUri,
      etag: resource.etag ?? null,
      size: resource.data.length,
      digest: sha256(resource.data),
      storedAt: new Date().toISOString(),
    };
    const receipt = { resource: stored, receiptDigest: digest(JSON.stringify(stored)) };
    await writeJsonAtomic(this.receiptPathFor(resourcePath), receipt);
    return receipt;
  }

  async verifyStored(resourcePath) {
    const receipt = await this.readResourceReceipt(resourcePath);
    if (!receipt) return null;
    const bytes = await readFile(resourcePath);
    if (sha256(bytes) !== receipt.resource.digest) {
      throw new Error(`资源校验失败: ${resourcePath}`);
    }
    return receipt;
  }

  jobPath(studyUid) {
    assertUid(studyUid, '检查');
    return join(this.jobsRoot, `${studyUid}.json`);
  }

  async saveJob(job) {
    await mkdir(this.jobsRoot, { recursive: true });
    await writeJsonAtomic(this.jobPath(job.studyUid), job);
    return job;
  }

  async loadJob(studyUid) {
    try {
      return await readJson(this.jobPath(studyUid));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  publishedPath(studyUid) {
    assertUid(studyUid, '检查');
    return join(this.publishedRoot, `${studyUid}.json`);
  }

  // 只有完整的一版检查才能发布；发布对讨论区可见，未封口检查在此处不可见
  async publish(studyUid, manifest) {
    if (manifest.state !== 'sealed') throw new Error('检查未封口，不能发布');
    await mkdir(this.publishedRoot, { recursive: true });
    const payload = { ...manifest, publishedAt: new Date().toISOString() };
    await writeJsonAtomic(this.publishedPath(studyUid), payload);
    return payload;
  }

  async readPublished(studyUid) {
    try {
      return await readJson(this.publishedPath(studyUid));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listPublished() {
    try {
      return (await readdir(this.publishedRoot)).filter(name => name.endsWith('.json'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
}
