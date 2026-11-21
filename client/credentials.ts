/**
 * 显式凭据与显式身份解析。
 *
 * 新版本不再接受“宿主环境里正好有 AGENTNET_TOKEN / AGENTNET_TOKEN_FILE”作为
 * 可用凭据：每次运行都必须显式传 `--env-file`、`--token` 或 `--token-file`。
 * `--env-file` 内的凭据声明是该文件的显式内容，优先于宿主继承值，避免多个
 * Agent 共用同一份全局环境而身份坍缩。
 */
import type { LoadedEnvFile } from './env-file';
import { CliError, readTokenFile } from './mcp';

export type CredentialSource = '--token' | '--token-file' | '--env-file';

export interface ExplicitCredential {
  token: string;
  source: CredentialSource;
  /** 显式文件路径；`--token` 没有路径。 */
  path?: string;
}

export interface CredentialOptions {
  token?: string;
  tokenFile?: string;
}

let explicitEnvFiles: readonly LoadedEnvFile[] = [];

/** main 在 commander 解析前记录显式加载的文件；测试可重置为空。 */
export function setExplicitEnvFiles(files: readonly LoadedEnvFile[]): void {
  explicitEnvFiles = files;
}

function fileValue(file: LoadedEnvFile, key: string): string | undefined {
  for (const [name, value] of file.entries) {
    if (name === key) return value;
  }
  return undefined;
}

/**
 * 解析显式凭据。优先级：--token > --token-file > --env-file 内的
 * AGENTNET_TOKEN > AGENTNET_TOKEN_FILE。只返回显式来源，不读取宿主环境。
 */
export function findExplicitCredential(options: CredentialOptions): ExplicitCredential | null {
  if (options.token !== undefined && options.token !== '') {
    return { token: options.token, source: '--token' };
  }
  if (options.tokenFile !== undefined && options.tokenFile !== '') {
    return {
      token: readTokenFile(options.tokenFile, '--token-file'),
      source: '--token-file',
      path: options.tokenFile,
    };
  }
  for (const file of explicitEnvFiles) {
    const token = fileValue(file, 'AGENTNET_TOKEN');
    if (token !== undefined && token !== '') {
      return { token, source: '--env-file', path: file.path };
    }
    const tokenFile = fileValue(file, 'AGENTNET_TOKEN_FILE');
    if (tokenFile !== undefined && tokenFile !== '') {
      return {
        token: readTokenFile(tokenFile, 'AGENTNET_TOKEN_FILE'),
        source: '--env-file',
        path: file.path,
      };
    }
  }
  return null;
}

export function requireExplicitCredential(options: CredentialOptions): ExplicitCredential {
  const credential = findExplicitCredential(options);
  if (credential !== null) return credential;
  throw new CliError(
    '缺少显式凭据：每个 Agent 使用自己的 env 文件，例如 ' +
      '--env-file ~/.agentnet/agents/<actor_id>.env；不接受仅从宿主环境继承 ' +
      'AGENTNET_TOKEN / AGENTNET_TOKEN_FILE。也可显式传 --token 或 --token-file' +
      '（POSIX 下文件权限必须是 600）。',
    { code: 'credentials_required' },
  );
}

/**
 * 解析显式身份：`--expect-actor` 或显式 env 文件内的
 * `AGENTNET_EXPECT_ACTOR`。宿主环境中的同名变量不算显式来源。
 */
export function findExplicitExpectActor(options: { expectActor?: string }): string | null {
  if (options.expectActor !== undefined && options.expectActor !== '') {
    return options.expectActor;
  }
  for (const file of explicitEnvFiles) {
    const actor = fileValue(file, 'AGENTNET_EXPECT_ACTOR');
    if (actor !== undefined && actor !== '') return actor;
  }
  return null;
}

export function requireExpectedActor(options: { expectActor?: string }): string {
  const actor = findExplicitExpectActor(options);
  if (actor !== null) return actor;
  throw new CliError(
    '缺少显式身份：使用 --expect-actor <actor_id>，或在 --env-file 文件中设置 ' +
      'AGENTNET_EXPECT_ACTOR=<actor_id>。',
    { code: 'actor_required' },
  );
}
