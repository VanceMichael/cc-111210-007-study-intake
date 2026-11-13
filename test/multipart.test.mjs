import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart, verifyFrameParts, frameNumberFromLocation } from '../src/multipart.mjs';

const TS = '1.2.840.10008.1.2.1';
const requestUrl = 'http://127.0.0.1:8080/instances/1.1.1/frames/1,2';

function multipart(parts, boundary = 'frames') {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const headers = [
      `Content-Type: ${part.mediaType}; transfer-syntax=${part.transferSyntax}`,
      `Content-Location: ${part.location}`,
      `Content-ID: <${part.contentId}>`,
      '',
      '',
    ].join('\r\n');
    chunks.push(Buffer.from(headers, 'latin1'), part.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    contentType: `multipart/related; type="application/octet-stream"; boundary=${boundary}`,
    body: Buffer.concat(chunks),
  };
}

const goodParts = [
  { mediaType: 'application/octet-stream', transferSyntax: TS, location: '/instances/1.1.1/frames/2', contentId: 'frame-2', data: Buffer.from('BB') },
  { mediaType: 'application/octet-stream', transferSyntax: TS, location: '/instances/1.1.1/frames/1', contentId: 'frame-1', data: Buffer.from('AA') },
];

test('multipart 解析保持二进制字节并按 Content-Location 关联乱序帧', () => {
  const { contentType, body } = multipart(goodParts);
  const parts = parseMultipart(contentType, body);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].data, Buffer.from('BB')); // 返回次序与请求次序不同
  const frames = verifyFrameParts({
    parts,
    requestUrl,
    requestedFrames: [1, 2],
    acceptedMediaTypes: ['application/octet-stream'],
  });
  assert.deepEqual([...frames.keys()].sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(frames.get(1).data, Buffer.from('AA'));
  assert.equal(frames.get(1).contentId, 'frame-1');
  assert.equal(frames.get(2).transferSyntax, TS);
});

test('Content-ID 重复、缺失或帧号不匹配时拒绝整批响应', () => {
  const { contentType, body } = multipart([
    { ...goodParts[0], contentId: 'dup' },
    { ...goodParts[1], contentId: 'dup' },
  ]);
  assert.throws(() => verifyFrameParts({
    parts: parseMultipart(contentType, body), requestUrl, requestedFrames: [1, 2],
  }), /Content-ID 重复/);

  const missing = multipart([{ ...goodParts[0] }]);
  assert.throws(() => verifyFrameParts({
    parts: parseMultipart(missing.contentType, missing.body), requestUrl, requestedFrames: [1, 2],
  }), /数量不符/);

  const stray = multipart([
    goodParts[0],
    { mediaType: 'application/octet-stream', transferSyntax: TS, location: '/instances/1.1.1/frames/9', contentId: 'frame-9', data: Buffer.from('X') },
  ]);
  assert.throws(() => verifyFrameParts({
    parts: parseMultipart(stray.contentType, stray.body), requestUrl, requestedFrames: [1, 2],
  }), /未请求的帧号/);
});

test('实际媒体类型与传输语法必须与请求核对一致', () => {
  const wrongType = multipart([
    { ...goodParts[0], mediaType: 'text/plain' },
    goodParts[1],
  ]);
  assert.throws(() => verifyFrameParts({
    parts: parseMultipart(wrongType.contentType, wrongType.body),
    requestUrl, requestedFrames: [1, 2], acceptedMediaTypes: ['application/octet-stream'],
  }), /媒体类型/);

  const wrongSyntax = multipart([
    { ...goodParts[0], transferSyntax: '1.2.840.10008.1.2.5' },
    goodParts[1],
  ]);
  assert.throws(() => verifyFrameParts({
    parts: parseMultipart(wrongSyntax.contentType, wrongSyntax.body),
    requestUrl, requestedFrames: [1, 2], requestedTransferSyntax: TS,
  }), /传输语法与请求不符/);
});

test('畸形 multipart 与非单帧 Content-Location 被拒绝', () => {
  assert.throws(() => parseMultipart('multipart/related; boundary=x', Buffer.from('no boundary here')), /boundary/);
  assert.throws(() => frameNumberFromLocation('/instances/1.1.1/frames/1,2', requestUrl), /单帧定位/);
  assert.throws(() => frameNumberFromLocation('/studies/1', requestUrl), /不是帧资源/);
  assert.equal(frameNumberFromLocation(new URL('/instances/1.1.1/frames/3', 'http://x').href, requestUrl), 3);
});
