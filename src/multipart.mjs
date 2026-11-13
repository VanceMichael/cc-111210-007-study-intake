import { parseHeaderParameters } from './util.mjs';

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');

// 解析单个 part 的头部，仅允许 RFC 风格的单行头部，值去除空白
function parsePartHeaders(block) {
  const text = block.toString('latin1');
  const headers = {};
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('multipart 头部缺少冒号分隔');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name in headers) throw new Error(`multipart 头部重复: ${name}`);
    headers[name] = value;
  }
  return headers;
}

// 按 boundary 拆分 multipart/related 主体（二进制安全，不做任何字符集转换）
export function parseMultipart(contentType, body) {
  const { mediaType, params } = parseHeaderParameters(contentType);
  if (!mediaType.startsWith('multipart/')) throw new Error(`响应不是 multipart 内容: ${mediaType}`);
  const boundary = params.boundary;
  if (!boundary) throw new Error('multipart 响应缺少 boundary');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let position = body.indexOf(delimiter);
  if (position < 0) throw new Error('multipart 主体缺少起始 boundary');
  position += delimiter.length;
  for (;;) {
    if (body.slice(position, position + 2).toString('latin1') === '--') break; // 结束标记
    position += 2; // 跳过 boundary 后的 CRLF
    const next = body.indexOf(delimiter, position);
    if (next < 0) throw new Error('multipart 主体未正常结束');
    let segment = body.subarray(position, next);
    // 每个 part 与下一个 boundary 之间有一个 CRLF
    if (segment.length < 2 || segment.subarray(segment.length - 2).toString('latin1') !== '\r\n') {
      throw new Error('multipart part 缺少结束 CRLF');
    }
    segment = segment.subarray(0, segment.length - 2);
    const split = segment.indexOf(DOUBLE_CRLF);
    if (split < 0) throw new Error('multipart part 缺少头部与主体分隔');
    const headers = parsePartHeaders(segment.subarray(0, split));
    const data = Buffer.from(segment.subarray(split + 4)); // 复制，避免持有整个响应缓冲
    parts.push({ headers, data });
    position = next + delimiter.length;
  }
  if (parts.length === 0) throw new Error('multipart 响应没有任何 part');
  return parts;
}

// 从 Content-Location（可为相对/绝对 URL）提取帧号：…/frames/<帧号>
export function frameNumberFromLocation(contentLocation, requestUrl) {
  if (!contentLocation) throw new Error('part 缺少 Content-Location，无法关联帧号');
  let pathname;
  try {
    pathname = new URL(contentLocation, requestUrl).pathname;
  } catch {
    throw new Error(`part 的 Content-Location 无法解析: ${contentLocation}`);
  }
  const marker = '/frames/';
  const index = pathname.indexOf(marker);
  if (index < 0) throw new Error(`part 的 Content-Location 不是帧资源: ${pathname}`);
  const tail = pathname.slice(index + marker.length);
  if (!/^\d+$/.test(tail)) throw new Error(`part 帧号不是单帧定位: ${tail}`);
  return Number(tail);
}

// 核对一次分帧请求与 multipart 响应的对应关系，返回 帧号 -> 已核对 part
// 必须核对：part 数量、Content-ID、实际媒体类型/传输语法、Content-Location 帧号、请求帧号集合
export function verifyFrameParts({ parts, requestUrl, requestedFrames, acceptedMediaTypes, requestedTransferSyntax }) {
  if (parts.length !== requestedFrames.length) {
    throw new Error(`分帧数量不符：请求 ${requestedFrames.length} 帧，收到 ${parts.length} part`);
  }
  const wanted = new Set(requestedFrames);
  const seenContentIds = new Set();
  const frames = new Map();
  for (const part of parts) {
    const contentId = part.headers['content-id'];
    if (!contentId) throw new Error('part 缺少 Content-ID');
    const normalizedId = contentId.trim().replace(/^<|>$/g, '');
    if (!normalizedId) throw new Error('part 的 Content-ID 为空');
    if (seenContentIds.has(normalizedId)) throw new Error(`Content-ID 重复: ${normalizedId}`);
    seenContentIds.add(normalizedId);

    const { mediaType, params } = parseHeaderParameters(part.headers['content-type']);
    if (!mediaType) throw new Error(`part ${normalizedId} 缺少 Content-Type`);
    if (acceptedMediaTypes && acceptedMediaTypes.length && !acceptedMediaTypes.includes(mediaType)) {
      throw new Error(`part ${normalizedId} 媒体类型不在可接受清单: ${mediaType}`);
    }
    const transferSyntax = params['transfer-syntax'];
    if (!transferSyntax) throw new Error(`part ${normalizedId} 缺少 transfer-syntax 参数`);
    if (requestedTransferSyntax && transferSyntax !== requestedTransferSyntax) {
      throw new Error(`传输语法与请求不符：请求 ${requestedTransferSyntax}，实际 ${transferSyntax}`);
    }
    const frame = frameNumberFromLocation(part.headers['content-location'], requestUrl);
    if (!wanted.has(frame)) throw new Error(`收到未请求的帧号: ${frame}`);
    if (frames.has(frame)) throw new Error(`帧号 ${frame} 在响应中重复出现`);
    frames.set(frame, { contentId: normalizedId, mediaType, transferSyntax, data: part.data });
  }
  if (frames.size !== requestedFrames.length) throw new Error('分帧响应无法覆盖全部请求帧号');
  return frames;
}
