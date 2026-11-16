#!/usr/bin/env bun
/**
 * Hindsight 写入核对 CLI（只读）。
 *
 * 运行：
 *   bun scripts/verify-hindsight-writes.ts --dry-run
 *   HINDSIGHT_URL=... HINDSIGHT_API_KEY=... bun scripts/verify-hindsight-writes.ts
 *
 * 退出码：0 完成；1 参数/配置/读取失败；2 存在 coverage 缺口且指定 --fail-on-gap。
 * 不输出正文、bank 凭据或 provider 原始错误正文。
 */
import {
  auditHelp,
  formatAuditReport,
  parseAuditArgs,
  runHindsightWriteAudit,
} from './lib/hindsight-write-audit';

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseAuditArgs>;
  try {
    parsed = parseAuditArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'invalid arguments');
    console.error(auditHelp());
    return 1;
  }
  if ('help' in parsed) {
    console.log(auditHelp());
    return 0;
  }
  let report;
  try {
    report = await runHindsightWriteAudit(parsed);
  } catch (error) {
    console.error(
      `hindsight write audit failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return 1;
  }
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatAuditReport(report));
  }
  const hasGap =
    report.totals.missing > 0 ||
    report.totals.extra > 0 ||
    report.totals.suppressed_extra > 0;
  return parsed.failOnGap && hasGap ? 2 : 0;
}

process.exitCode = await main();
