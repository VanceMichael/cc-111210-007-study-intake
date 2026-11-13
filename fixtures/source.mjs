import { listen } from '../src/http.mjs';

const EXPLICIT_VR_LITTLE = '1.2.840.10008.1.2.1';
const RLE_LOSSLESS = '1.2.840.10008.1.2.5';

function parseAcceptTransferSyntax(acceptHeader) {
  for (const part of String(acceptHeader ?? '').split(',')) {
    const segments = part.split(';').map(item => item.trim());
    for (const segment of segments) {
      const match = /^transfer-syntax=(.+)$/.exec(segment);
      if (match) {
        const value = match[1].replace(/^"|"$/g, '');
        if (value === RLE_LOSSLESS) return value;
        return value;
      }
    }
  }
  return EXPLICIT_VR_LITTLE;
}

// 可重复启动的本地演练来源：
//  - /studies/1/instances 返回 DICOM JSON，ETag 代表目录版次；/advance 新增实例
//  - /bulk/<id> 提供大字段字节；external=1 时返回绝对外域 URI（演练授权清单边界）
//  - /instances/<uid>/frames/<list> 返回故意乱序的 multipart 分帧，按 Accept 选择传输表示
//  - /flaky 注入/解除 500 故障，用于演示未完成清单与单资源重取
export async function startFixture(options = {}) {
  const state = {
    version: 1,
    external: options.externalOrigin ?? 'https://imaging.example.edu',
    flaky: new Set(),
    stats: { catalog: 0, bulk: new Map(), frames: new Map(), advance: 0 },
  };

  function bump(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }

  function makeBulk(id) {
    // 不同实例的大字段内容不同，避免摘要混淆
    return Buffer.from(`bulk-${id}-`.padEnd(16, '#').slice(0, 16));
  }

  function frameBody(instanceUid, frame, transferSyntax) {
    if (transferSyntax === RLE_LOSSLESS) return Buffer.from(`rle:${instanceUid}:${frame}`);
    return Buffer.from(`frame:${instanceUid}:${frame}`);
  }

  function framePart({ instanceUid, frame, transferSyntax, mediaType }) {
    const lines = [
      `Content-Type: ${mediaType}; transfer-syntax=${transferSyntax}`,
      `Content-Location: /instances/${instanceUid}/frames/${frame}`,
      `Content-ID: <frame-${frame}>`,
      '',
      '',
    ];
    return Buffer.concat([Buffer.from(lines.join('\r\n'), 'latin1'), frameBody(instanceUid, frame, transferSyntax)]);
  }

  function isFlaky(prefix, ...parts) {
    return state.flaky.has(`${prefix}:${parts.join(':')}`);
  }

  function frameResponse(instanceUid, frameList, acceptHeader) {
    const transferSyntax = parseAcceptTransferSyntax(acceptHeader);
    const mediaType = 'application/octet-stream';
    // 故意与请求次序不同的返回次序，关联只看 Content-Location / Content-ID
    const ordered = [...frameList].reverse();
    const chunks = [];
    for (const frame of ordered) {
      chunks.push(Buffer.from('--frames\r\n'));
      chunks.push(framePart({ instanceUid, frame, transferSyntax, mediaType }), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from('--frames--\r\n'));
    return {
      type: `multipart/related; type="${mediaType}"; boundary=frames`,
      body: Buffer.concat(chunks),
    };
  }

  return listen(async (url, request) => {
    if (url.pathname === '/advance') {
      state.version += 1;
      state.stats.advance += 1;
      return { body: { version: state.version } };
    }
    if (url.pathname === '/stats/reset' && request.method === 'POST') {
      state.stats = { catalog: 0, bulk: new Map(), frames: new Map(), advance: state.stats.advance };
      return { body: { reset: true } };
    }
    if (url.pathname === '/stats') {
      return {
        body: {
          catalog: state.stats.catalog,
          advance: state.stats.advance,
          bulk: Object.fromEntries(state.stats.bulk),
          frames: Object.fromEntries(state.stats.frames),
          flaky: [...state.flaky],
        },
      };
    }
    if (url.pathname === '/flaky' && request.method === 'POST') {
      const key = url.searchParams.get('key') ?? '';
      if (!/^[a-z0-9:._/-]{1,160}$/.test(key)) return { status: 400, body: { error: '故障注入标识无效' } };
      if (state.flaky.has(key)) state.flaky.delete(key); else state.flaky.add(key);
      return { body: { key, flaky: state.flaky.has(key) } };
    }
    if (url.pathname === '/studies/1/instances') {
      state.stats.catalog += 1;
      const ids = state.version > 1 ? ['1.1.1', '1.1.2'] : ['1.1.1'];
      const external = url.searchParams.get('external') === '1';
      return {
        headers: { etag: `"study-${state.version}"` },
        body: ids.map(id => {
          const row = {
            '0020000D': { vr: 'UI', Value: ['1'] },
            '0020000E': { vr: 'UI', Value: ['1.1'] },
            '00080018': { vr: 'UI', Value: [id] },
            '00280008': { vr: 'IS', Value: [2] },
            '7FE00010': { vr: 'OB', BulkDataURI: external ? `${state.external}/bulk/${id}` : `/bulk/${id}` },
          };
          // 第二个实例额外携带一个非像素大字段，演示 BulkDataURI 不局限于像素标签
          if (id === '1.1.2') row['00420011'] = { vr: 'OB', BulkDataURI: `/bulk/${id}-encapsulated` };
          return row;
        }),
      };
    }
    if (url.pathname.startsWith('/bulk/')) {
      bump(state.stats.bulk, url.pathname);
      if (isFlaky('bulk', url.pathname)) {
        return { status: 500, body: { error: '演练注入：大字段暂时不可用' } };
      }
      const body = makeBulk(url.pathname.slice('/bulk/'.length));
      return { type: 'application/octet-stream', body, headers: { etag: `"raw-${state.version}"` } };
    }
    const frameMatch = /^\/instances\/([\d.]+)\/frames\/([\d,]+)$/.exec(url.pathname);
    if (frameMatch) {
      const instanceUid = frameMatch[1];
      const frameList = frameMatch[2].split(',').map(Number);
      if (frameList.some(frame => !Number.isInteger(frame) || frame < 1)) {
        return { status: 400, body: { error: '帧号无效' } };
      }
      const transferSyntax = parseAcceptTransferSyntax(request.headers.accept);
      bump(state.stats.frames, `${instanceUid}:${frameList.join(',')}`);
      // 单帧故障可演示整批失败后的逐帧重取；整实例故障让资源进入未完成清单
      if (frameList.some(frame => isFlaky('frame', instanceUid, frame, transferSyntax)) ||
        isFlaky('frame', instanceUid, 'all', transferSyntax)) {
        return { status: 500, body: { error: '演练注入：分帧资源暂时不可用' } };
      }
      return frameResponse(instanceUid, frameList, request.headers.accept);
    }
    if (url.pathname === '/redirect-to-bulk') {
      const target = url.searchParams.get('target') ?? '/bulk/1.1.1';
      return { status: 302, headers: { location: target }, body: '' };
    }
    return { status: 404, body: { error: '资源不存在' } };
  });
}
