/**
 * MCP Events 文件日志单元验收：目录创建、追加、轮转、fail-open 与脱敏。
 * 只使用临时目录，不触碰生产 DATA_DIR。
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { check, checkEqual } from './harness';
import {
  initEventsFileLog,
  resetEventsFileLog,
  writeEventsLogLine,
} from '../../src/events/log-file';
import { logEventsInfo, logEventsWarn } from '../../src/events/log';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function lineCount(path: string): number {
  return read(path).split('\n').filter((line) => line.length > 0).length;
}

export function runEventsFileLogChecks(): void {
  const root = mkdtempSync(join(tmpdir(), 'an-events-log-'));
  try {
    resetEventsFileLog();
    const filePath = join(root, 'nested', 'logs', 'events.log');
    check('文件日志初始化成功', initEventsFileLog({ filePath }));
    check('文件日志目录自动创建', existsSync(join(root, 'nested', 'logs')));
    check('日志文件初始不存在', !existsSync(filePath));

    logEventsInfo('unit', { stage: 'unit.append.one', callback_host: '127.0.0.1' });
    check('文件日志写入第一行', existsSync(filePath) && lineCount(filePath) === 1);
    const first = read(filePath);
    check('文件日志带固定前缀', first.startsWith('agent-network events {'));
    check('文件日志是 JSON 行', first.includes('"stage":"unit.append.one"'));

    logEventsInfo('unit', { stage: 'unit.append.two' });
    checkEqual('文件日志追加第二行', lineCount(filePath), 2);
    check('文件日志保留第一行', read(filePath).includes('"stage":"unit.append.one"'));

    // 轮转：阈值远小于单行时，每两次写入触发一次；只保留指定备份数。
    resetEventsFileLog();
    const rotatedPath = join(root, 'rotate', 'events.log');
    check(
      '可配置轮转阈值',
      initEventsFileLog({ filePath: rotatedPath, maxBytes: 140, backups: 2 }),
    );
    for (let index = 0; index < 6; index += 1) {
      logEventsInfo('unit', { stage: `unit.rotate.${index}` });
    }
    check('轮转生成 .1', existsSync(`${rotatedPath}.1`));
    check('轮转生成 .2', existsSync(`${rotatedPath}.2`));
    check('轮转不超过备份数', !existsSync(`${rotatedPath}.3`));
    check('当前文件保留最新行', read(rotatedPath).includes('"stage":"unit.rotate.5"'));
    check(
      '备份文件只包含日志行',
      read(`${rotatedPath}.1`).split('\n').filter(Boolean).every((line) => line.startsWith('agent-network events ')),
    );
    check('轮转后文件大小受控', statSync(rotatedPath).size <= 140 + 256);

    // 敏感字段与 URL 脱敏；secret/token/signature 不落盘。
    resetEventsFileLog();
    const redactPath = join(root, 'redact', 'events.log');
    check('脱敏用例初始化', initEventsFileLog({ filePath: redactPath }));
    const secret = `whsec_${crypto.randomUUID().replaceAll('-', '')}`;
    const token = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
    const signature = 'v1,AbCdEf0123456789';
    logEventsWarn('unit', {
      stage: 'unit.redact',
      secret,
      token,
      webhook_signature: signature,
      callback_url: `https://callback.example/private/path?token=${token}`,
      error_message: `connect failed https://callback.example/private/path?token=${token} ${token}`,
    });
    const redacted = read(redactPath);
    for (const [label, value] of [
      ['不落 secret', secret],
      ['不落 token', token],
      ['不落签名', signature],
      ['不落完整 callback URL', 'https://callback.example/private/path'],
      ['不落 URL 中的 token', token],
    ] as const) {
      check(`文件日志${label}`, !redacted.includes(value));
    }
    check('脱敏后保留 error_message 分类文本', redacted.includes('connect failed'));
    check('敏感字段显示为 [redacted]', redacted.includes('"callback_url":"[redacted]"'));

    // 初始化失败：父路径是普通文件 → 禁用文件日志，写入不抛错。
    resetEventsFileLog();
    const blockedParent = join(root, 'blocked');
    writeFileSync(blockedParent, 'not a directory');
    let initThrew = false;
    try {
      initEventsFileLog({ filePath: join(blockedParent, 'events.log') });
    } catch {
      initThrew = true;
    }
    check('目录创建失败不抛错', !initThrew);
    check('目录创建失败时文件日志禁用', !existsSync(join(blockedParent, 'events.log')));
    let writeThrew = false;
    try {
      writeEventsLogLine('agent-network events {"stage":"unit.fail.open"}');
    } catch {
      writeThrew = true;
    }
    check('未初始化写入 fail-open', !writeThrew);

    // 初始化成功后目录被删除：写入失败仍 fail-open。
    resetEventsFileLog();
    const removedDir = join(root, 'removed', 'logs');
    check('删除目录用例初始化', initEventsFileLog({ filePath: join(removedDir, 'events.log') }));
    rmSync(join(root, 'removed'), { recursive: true, force: true });
    let removedThrew = false;
    try {
      logEventsWarn('unit', { stage: 'unit.removed.dir' });
    } catch {
      removedThrew = true;
    }
    check('目录被删除后写入 fail-open', !removedThrew);
    check('删除目录后未重建日志文件', !existsSync(join(removedDir, 'events.log')));
    check(
      '临时目录只含预期子目录',
      readdirSync(root).sort().join(',') === 'blocked,nested,redact,rotate',
      readdirSync(root).sort(),
    );
  } finally {
    resetEventsFileLog();
    rmSync(root, { recursive: true, force: true });
  }
}
