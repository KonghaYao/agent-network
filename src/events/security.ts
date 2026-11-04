import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { LIMITS } from '../contracts/limits';
import { utf8Bytes } from '../storage/db';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.internal.',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

/**
 * SSRF 目标地址策略：只允许全球单播。
 *
 * - IPv4：拒绝 IANA 特殊用途注册表中的非全球地址；其余 IPv4 即全球单播。
 * - IPv6：先要求落在 `2000::/3` 全球单播，再排除其中的特殊用途前缀。
 *   因此 `fec0::/10`、`100::/64`、`64:ff9b::/96`、`64:ff9b:1::/48`
 *   等不在 `2000::/3` 内的 site-local、discard-only 与转换前缀天然被拒；
 *   `2002::/16`（6to4）、Teredo、ORCHID 等位于 `2000::/3` 内的特殊前缀
 *   额外拒绝。
 */
const NON_GLOBAL_V4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_GLOBAL_V4.addSubnet(network, prefix, 'ipv4');
}

const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

const NON_GLOBAL_V6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:30::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  NON_GLOBAL_V6.addSubnet(network, prefix, 'ipv6');
}

/** 严格 base64 / base64url 解码；非法字符或非规范长度返回 null。 */
export function decodeBase64Strict(input: string): Uint8Array | null {
  const normalized = input.trim().replace(/-/gu, '+').replace(/_/gu, '/');
  if (normalized.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) return null;
  const unpadded = normalized.replace(/=+$/u, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const buffer = Buffer.from(padded, 'base64');
  if (buffer.toString('base64').replace(/=+$/u, '') !== unpadded) return null;
  return new Uint8Array(buffer);
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** 复制到独立的 ArrayBuffer，满足 WebCrypto 的 BufferSource 类型。 */
function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv4FromMapped(address: string): { address: string; family: 4 } | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  if (dotted) return { address: dotted[1]!, family: 4 };
  const compatible = /^::(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address);
  if (compatible) return { address: compatible[1]!, family: 4 };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/iu.exec(address);
  if (!hex) return null;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return {
    address: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
    family: 4,
  };
}

export function isPublicAddress(raw: string): boolean {
  const address = stripBrackets(raw);
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !NON_GLOBAL_V4.check(address, 'ipv4');
  const mapped = ipv4FromMapped(address);
  if (mapped) return !NON_GLOBAL_V4.check(mapped.address, 'ipv4');
  return (
    GLOBAL_UNICAST_V6.check(address, 'ipv6') && !NON_GLOBAL_V6.check(address, 'ipv6')
  );
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (host === 'localhost' || BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export class CallbackTargetError extends Error {
  readonly reason: 'dns_error' | 'blocked_address';

  constructor(reason: 'dns_error' | 'blocked_address', message: string) {
    super(message);
    this.name = 'CallbackTargetError';
    this.reason = reason;
  }
}

export interface CallbackUrlRules {
  allowPrivateCallbacks: boolean;
  callbackAllowlist: ReadonlySet<string> | null;
}

/** 校验并规范化 callback URL；query 属于 callback 身份。 */
export function normalizeCallbackUrl(raw: string, rules: CallbackUrlRules): URL {
  if (utf8Bytes(raw) > LIMITS.eventsCallbackUrlMaxBytes) {
    throw new CallbackUrlError('url_too_long');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackUrlError('invalid_url');
  }
  if (url.protocol !== 'https:') throw new CallbackUrlError('not_https');
  if (url.username !== '' || url.password !== '') throw new CallbackUrlError('userinfo');
  if (url.hash !== '') throw new CallbackUrlError('fragment');
  if (url.hostname === '') throw new CallbackUrlError('missing_host');
  if (!rules.allowPrivateCallbacks && blockedHostname(url.hostname)) {
    throw new CallbackUrlError('private_address');
  }
  if (rules.callbackAllowlist && !rules.callbackAllowlist.has(url.hostname.toLowerCase())) {
    throw new CallbackUrlError('host_not_allowed');
  }
  return url;
}

export class CallbackUrlError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`invalid callback url: ${reason}`);
    this.name = 'CallbackUrlError';
    this.reason = reason;
  }
}

export interface CallbackTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
}

/**
 * 每次验证/投递都重新解析；固定一个已校验地址，保留原 hostname 用于
 * Host 与 TLS SNI，避免 DNS rebinding 与 SNI 失配。
 */
export async function resolveCallbackTarget(
  url: URL,
  rules: CallbackUrlRules,
): Promise<CallbackTarget> {
  const hostname = stripBrackets(url.hostname);
  const literalFamily = isIP(hostname);
  let candidates: { address: string; family: number }[];
  if (literalFamily !== 0) {
    candidates = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      candidates = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new CallbackTargetError('dns_error', 'callback hostname could not be resolved');
    }
  }
  const usable = candidates.filter(
    (candidate) => rules.allowPrivateCallbacks || isPublicAddress(candidate.address),
  );
  if (usable.length === 0) {
    throw new CallbackTargetError('blocked_address', 'callback address is not public');
  }
  const selected = usable[0]!;
  return {
    hostname,
    address: selected.address,
    family: selected.family === 6 ? 6 : 4,
  };
}

/** whsec_ + strict base64；解码后 24–64 字节。 */
export function parseWebhookSecret(secret: string): Uint8Array {
  if (!secret.startsWith('whsec_')) throw new SecretError('missing_prefix');
  const bytes = decodeBase64Strict(secret.slice('whsec_'.length));
  if (!bytes) throw new SecretError('invalid_base64');
  if (bytes.length < 24 || bytes.length > 64) throw new SecretError('invalid_length');
  return bytes;
}

export class SecretError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`invalid webhook secret: ${reason}`);
    this.name = 'SecretError';
    this.reason = reason;
  }
}

export async function loadEncryptionKey(base64: string): Promise<CryptoKey | null> {
  const bytes = decodeBase64Strict(base64);
  if (!bytes || bytes.length !== 32) return null;
  return crypto.subtle.importKey('raw', ownedBytes(bytes), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export interface EncryptedSecret {
  ciphertext: string;
  nonce: string;
}

export async function encryptSecret(key: CryptoKey, plaintext: string): Promise<EncryptedSecret> {
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    encoder.encode(plaintext),
  );
  return {
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    nonce: encodeBase64(nonce),
  };
}

export async function decryptSecret(
  key: CryptoKey,
  ciphertext: string,
  nonce: string,
): Promise<string> {
  const ciphertextBytes = decodeBase64Strict(ciphertext);
  const nonceBytes = decodeBase64Strict(nonce);
  if (!ciphertextBytes || !nonceBytes || nonceBytes.length !== 12) {
    throw new Error('encrypted secret is malformed');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ownedBytes(nonceBytes) },
    key,
    ownedBytes(ciphertextBytes),
  );
  return decoder.decode(plaintext);
}

/** Standard Webhooks：v1, base64(HMAC-SHA256(secret, id.timestamp.body))。 */
export function signWebhook(
  secretBytes: Uint8Array,
  webhookId: string,
  timestamp: string,
  body: string,
): string {
  const digest = createHmac('sha256', secretBytes)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${digest}`;
}

export function webhookTimestamp(now = Date.now()): string {
  return String(Math.floor(now / 1000));
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}
