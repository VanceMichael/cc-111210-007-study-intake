import { parseMultipart, verifyFrameParts } from './multipart.mjs';
import { baseMediaType, parseHeaderParameters } from './util.mjs';

// DICOMweb 网关客户端：目录（DICOM JSON）、大字段（BulkDataURI）、分帧资源。
// 所有外发请求都经过 FetchPolicy 的授权清单与凭据边界。
export class DICOMwebClient {
  constructor({ policy, studyPath = '/studies/1' }) {
    this.policy = policy;
    this.studyPath = studyPath;
  }

  async request(path, { headers, accept } = {}) {
    const url = new URL(path, this.policy.sourceOrigin);
    const finalHeaders = { ...headers };
    if (accept) finalHeaders.accept = accept;
    const response = await this.policy.fetch(url, { headers: finalHeaders });
    if (!response.ok) throw new Error(`来源返回 ${response.status}（${url.pathname}）`);
    return response;
  }

  // QIDO-RS 风格目录；ETag 代表目录版次
  async fetchCatalog() {
    const response = await this.request(`${this.studyPath}/instances`, {
      accept: 'application/dicom+json',
    });
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('实例目录不是 JSON 数组');
    return { rows, etag: response.headers.get('etag'), mediaType: baseMediaType(response.headers.get('content-type')) };
  }

  // WADO-RS 大字段；返回字节与实际媒体类型、ETag
  async fetchBulk(uri) {
    const response = await this.request(uri, { accept: 'application/octet-stream' });
    const mediaType = baseMediaType(response.headers.get('content-type')) || 'application/octet-stream';
    const data = Buffer.from(await response.arrayBuffer());
    return { data, mediaType, etag: response.headers.get('etag') };
  }

  // WADO-RS 分帧：一次请求多个帧号，核对 Content-ID、实际媒体类型、帧号与请求的对应关系。
  // requestedTransferSyntax 为空表示不指定，接受服务端选择的任一（但全部 part 必须一致）。
  async fetchFrames(instanceUid, frames, { mediaType = 'application/octet-stream', transferSyntax } = {}) {
    const frameList = frames.join(',');
    const path = `/instances/${encodeURIComponent(instanceUid)}/frames/${frameList}`;
    const acceptParts = transferSyntax ? [`${mediaType}; transfer-syntax=${transferSyntax}`] : [mediaType];
    const response = await this.request(path, { accept: acceptParts.join(', ') });
    const { mediaType: responseType, params } = parseHeaderParameters(response.headers.get('content-type'));
    if (!responseType.startsWith('multipart/')) throw new Error(`分帧响应不是 multipart: ${responseType}`);
    const body = Buffer.from(await response.arrayBuffer());
    const parts = parseMultipart(response.headers.get('content-type'), body);
    const checked = verifyFrameParts({
      parts,
      requestUrl: new URL(path, this.policy.sourceOrigin).href,
      requestedFrames: frames,
      acceptedMediaTypes: [mediaType],
      requestedTransferSyntax: transferSyntax ?? null,
    });
    // 未指定传输语法时，服务端可以按其可接受的表示返回，但同一响应内必须一致
    const syntaxes = new Set([...checked.values()].map(part => part.transferSyntax));
    if (syntaxes.size !== 1) throw new Error(`同一分帧响应出现多种传输语法: ${[...syntaxes].join(', ')}`);
    const actualTransferSyntax = [...syntaxes][0];
    // multipart 外层声明的 transfer-syntax（若有）也要与 part 实际声明一致
    if (params['transfer-syntax'] && params['transfer-syntax'] !== actualTransferSyntax) {
      throw new Error('multipart 外层与 part 的传输语法不一致');
    }
    return { frames: checked, mediaType, transferSyntax: actualTransferSyntax, boundary: params.boundary };
  }
}

// 扫描 DICOM JSON 实例中所有携带 BulkDataURI 的属性（不局限于像素标签）
export function* bulkReferences(row) {
  for (const [tag, element] of Object.entries(row)) {
    if (element && typeof element === 'object' && typeof element.BulkDataURI === 'string') {
      yield { tag, vr: element.vr ?? null, uri: element.BulkDataURI };
    }
  }
}

// DICOM JSON 元素取值的第一个标量（UI/IS 等）
export function scalar(row, tag) {
  const element = row[tag];
  return element && Array.isArray(element.Value) && element.Value.length > 0 ? element.Value[0] : null;
}
