/**
 * agentnet CLI 单文件 bundle：服务启动时构建到内存，由 `/skills/agentnet.js` 提供。
 *
 * 构建入口与选项只在这里定义，`scripts/build-client.ts` 离线写盘复用同一份配置，
 * 避免启动路径与离线路径产生两套产物。构建失败返回 null，不阻塞服务启动；
 * 日志只记录错误摘要，不输出源码、token 或部署信息。
 */

import { resolve } from 'node:path';

import { bundleVersion } from '../web/client-bundle';

export const CLI_BUNDLE_FILENAME = 'agentnet.js';
export const CLI_BUNDLE_SHEBANG = '#!/usr/bin/env bun';
export const CLI_ENTRY = resolve(import.meta.dir, '../../client/cli.ts');

export interface CliBundleAsset {
  /** 完整 JS 文本；只在内存缓存，不写磁盘。 */
  code: string;
  /** 内容哈希前 12 位；`/skills/agentnet.js` 用作 ETag。 */
  version: string;
}

/**
 * CLI bundle 的唯一构建配置。
 * 传入 outdir 时落盘给离线 `build:client` 使用，否则产物留在内存。
 */
export function cliBuildConfig(outdir?: string): Bun.BuildConfig {
  // bun-types 1.4.2 的 BuildConfig 尚未声明 `write`，运行时支持 write:false。
  return {
    entrypoints: [CLI_ENTRY],
    target: 'bun',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    banner: CLI_BUNDLE_SHEBANG,
    ...(outdir ? { outdir, naming: CLI_BUNDLE_FILENAME, write: true } : { write: false }),
  } as unknown as Bun.BuildConfig;
}

/** 启动期构建；失败返回 null，由调用方决定 404 而不是阻塞服务。 */
export async function buildCliBundle(): Promise<CliBundleAsset | null> {
  try {
    const result = await Bun.build(cliBuildConfig());
    if (!result.success) {
      const messages = result.logs
        .map((log) => log.message)
        .filter((message) => message.length > 0)
        .slice(0, 5);
      console.warn('cli bundle disabled:', messages.join(' | '));
      return null;
    }
    const entryOutput = result.outputs.find((output) => output.kind === 'entry-point');
    if (!entryOutput) {
      console.warn('cli bundle disabled: entry output missing');
      return null;
    }
    const text = await entryOutput.text();
    if (!text || text.length === 0) {
      console.warn('cli bundle disabled: empty entry output');
      return null;
    }
    return { code: text, version: bundleVersion(text) };
  } catch (error) {
    // 只记录错误摘要，不输出源码、token 或部署信息。
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('cli bundle disabled:', reason.slice(0, 300));
    return null;
  }
}
