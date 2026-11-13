import { createHash } from 'node:crypto';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// DICOM UID：仅数字与点，最长 64 字符；同时用于目录名，杜绝路径穿越
const UID_PATTERN = /^\d{1,8}(\.\d{1,8}){0,31}$/;
export function assertUid(value, label) {
  if (typeof value !== 'string' || !UID_PATTERN.test(value) || value.length > 64) {
    throw new Error(`${label} 不是合法 UID: ${String(value)}`);
  }
  return value;
}

const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;
export function assertKey(value, label) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new Error(`${label} 标识无效`);
  }
  return value;
}

// 媒体类型只取主类型/子类型字符，作为文件名片段时再次收窄
export function safeMediaType(mediaType) {
  const value = String(mediaType ?? '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,80}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,80}$/.test(value)) {
    throw new Error(`不支持的媒体类型: ${String(mediaType)}`);
  }
  return value.replace(/[^a-z0-9._+-]/g, '_');
}

export function baseMediaType(contentType) {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase();
}

export function parseHeaderParameters(headerValue) {
  const parts = String(headerValue ?? '').split(';').map(part => part.trim()).filter(Boolean);
  const mediaType = parts.shift()?.toLowerCase() ?? '';
  const params = {};
  for (const part of parts) {
    const equal = part.indexOf('=');
    if (equal < 0) continue;
    const key = part.slice(0, equal).trim().toLowerCase();
    let value = part.slice(equal + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    params[key] = value;
  }
  return { mediaType, params };
}
