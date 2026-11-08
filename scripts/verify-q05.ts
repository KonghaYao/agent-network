/**
 * Q05 并发故障与越权对抗验收入口。
 *
 * 自托管临时 Bun 实例（唯一 PORT/DATA_DIR、PUBLIC_ORIGIN 与 AGENTNET_URL 一致、
 * 短 presence 窗口），固定种子驱动 100 轮/场景的并发与故障矩阵。
 *
 * 复现：
 *   bun scripts/verify-q05.ts
 *   Q05_SEED=20261108 bun scripts/verify-q05.ts --scenario=claim-accept --round=37
 *   Q05_ROUNDS=10 bun scripts/verify-q05.ts --scenario=messages
 *
 * 断言只读权威 SQLite、实际权限与可观察事件；不以 HTTP 200 数量推断正确。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_ROUNDS,
  Q05Server,
  auditQ05Invariants,
  openQ05Db,
  q05Checks,
  q05Failures,
  runScenario,
  seedFromEnv,
  roundsFromEnv,
  type Q05Db,
  type ScenarioResult,
} from './lib/q05-harness';
import { setupQ05Fixture, type Q05Fixture } from './lib/q05-fixture';
import { q05MessagesRound } from './lib/q05-messages';
import { q05ClaimRound, q05OfferAcceptRound, q05ClaimStats } from './lib/q05-claims';
import {
  q05ReviewRaceRound,
  q05TaskTransferRaceRound,
  q05TaskRaceStats,
  q05ReviewStats,
} from './lib/q05-task-race';
import {
  q05FileBindingRound,
  printQ05FileStats,
  q05FileStats,
  q05QuotaCheck,
} from './lib/q05-files';
import { q05ContactRound, q05ContactStats } from './lib/q05-contacts';
import { q05DeviceRound, q05DeviceStats } from './lib/q05-devices';
import { q05AgentTransferRound, q05AgentTransferStats } from './lib/q05-agents';
import { q05OwnerTransferRound, q05OwnerStats } from './lib/q05-owners';
import { q05FaultBodies } from './lib/q05-faults';

function scenarioStats(): Record<string, unknown> {
  return {
    messages: '每轮 100 并发同意图 + 100 并发同 client_message_id + 冲突对',
    'claim-accept': {
      claimRounds: q05ClaimStats.claimRounds,
      claimWinners: q05ClaimStats.claimWinners,
      offerRounds: q05ClaimStats.offerRounds,
      acceptWinners: q05ClaimStats.acceptWinners,
    },
    'task-transfer-race': q05TaskRaceStats,
    'review-race': q05ReviewStats,
    'file-binding': q05FileStatsSnapshot(),
    contacts: q05ContactStats,
    devices: q05DeviceStats,
    'agent-transfer': q05AgentTransferStats,
    'owner-transfer': q05OwnerStats,
  };
}

function q05FileStatsSnapshot(): Record<string, number> {
  return {
    total: q05FileStats.total,
    submitted: q05FileStats.submitted,
    rolledBack: q05FileStats.rolledBack,
    removed: q05FileStats.removed,
  };
}

interface CliOptions {
  seed: number;
  rounds: number;
  scenario: string | null;
  round: number | null;
}

function parseCli(): CliOptions {
  const options: CliOptions = {
    seed: seedFromEnv(),
    rounds: roundsFromEnv(),
    scenario: null,
    round: null,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--seed=')) options.seed = Number(arg.slice(7));
    else if (arg.startsWith('--rounds=')) options.rounds = Number(arg.slice(9));
    else if (arg.startsWith('--scenario=')) options.scenario = arg.slice(11);
    else if (arg.startsWith('--round=')) options.round = Number(arg.slice(8));
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: bun scripts/verify-q05.ts [--seed=N] [--rounds=N] [--scenario=NAME] [--round=N]',
      );
      process.exit(0);
    }
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) options.seed = seedFromEnv();
  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1) options.rounds = DEFAULT_ROUNDS;
  if (options.round !== null && (!Number.isSafeInteger(options.round) || options.round < 1)) {
    options.round = null;
  }
  return options;
}

function printFailureDetail(): void {
  const failures = q05Failures();
  if (failures.length === 0) return;
  console.log('\n失败轮次（前 20 条）：');
  for (const failure of failures.slice(0, 20)) {
    console.log(
      `- ${failure.scenario} 第 ${failure.round} 轮: ${failure.label.slice(0, 500)}`,
    );
    if (failure.requestIds.length > 0) {
      console.log(`  请求 ID: ${failure.requestIds.join(',')}`);
    }
  }
}

function writeSummary(
  options: CliOptions,
  results: ScenarioResult[],
  startedAt: number,
): void {
  const summary = {
    task: 'Q05',
    status: results.every((result) => result.failed === 0) ? 'PASS' : 'FAIL',
    seed: options.seed,
    roundsPerScenario: options.rounds,
    scenarioFilter: options.scenario,
    roundFilter: options.round,
    checks: q05Checks(),
    stats: scenarioStats(),
    scenarios: results.map((result) => ({
      name: result.name,
      rounds: result.rounds,
      passed: result.passed,
      failed: result.failed,
      checks: result.checks,
      durationMs: result.durationMs,
      failures: result.failures.map((failure) => ({
        round: failure.round,
        label: failure.label,
        requestIds: failure.requestIds,
        repro: `Q05_SEED=${options.seed} bun scripts/verify-q05.ts --scenario=${result.name} --round=${failure.round}`,
      })),
    })),
    durationMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
  };
  const target = process.env.Q05_SUMMARY_PATH;
  if (!target) return;
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const options = parseCli();
  const startedAt = Date.now();
  console.log(
    `Q05 并发故障与越权对抗验收 · seed=${options.seed} · rounds=${options.rounds}${options.scenario ? ` · scenario=${options.scenario}` : ''}${options.round ? ` · round=${options.round}` : ''}`,
  );

  const server = await Q05Server.start();
  const db: Q05Db = openQ05Db(server.dbPath);
  const results: ScenarioResult[] = [];
  try {
    const fixture: Q05Fixture = await setupQ05Fixture(server);
    console.log(
      `夹具就绪：actors=${[fixture.u1, fixture.u2, fixture.u3, fixture.u4, fixture.u5, fixture.b1, fixture.b2, fixture.b3].length} room=${fixture.mainRoomId}`,
    );
    await q05QuotaCheck(server, db, fixture.u1);
    console.log('配额不足与恢复检查完成');

    const faultBodies = q05FaultBodies(server, db, fixture);
    const scenarios: {
      name: string;
      rounds?: number;
      body: Parameters<typeof runScenario>[2];
    }[] = [
      {
        name: 'messages',
        body: q05MessagesRound(
          server,
          db,
          fixture.u1,
          fixture.mainRoomId,
          fixture.b1,
          fixture.b2,
        ),
      },
      {
        name: 'claim-accept',
        body: async (round, random) => {
          await q05ClaimRound(
            server,
            db,
            fixture.u1,
            [fixture.u2, fixture.u3, fixture.b1, fixture.b2, fixture.b3],
            fixture.mainRoomId,
          )(round, random);
          await q05OfferAcceptRound(
            server,
            db,
            fixture.u1,
            fixture.b2,
            fixture.mainRoomId,
          )(round, random);
        },
      },
      {
        name: 'task-transfer-race',
        body: q05TaskTransferRaceRound(
          server,
          db,
          [fixture.u1, fixture.u2, fixture.u3, fixture.u4],
          fixture.agentsByOwner,
        ),
      },
      {
        name: 'review-race',
        body: q05ReviewRaceRound(server, db, fixture.u1, fixture.b1, fixture.mainRoomId),
      },
      {
        name: 'file-binding',
        body: q05FileBindingRound(
          server,
          db,
          [fixture.u1, fixture.u2, fixture.u3, fixture.u4],
          fixture.agentsByOwner,
          fixture.u5,
        ),
      },
      {
        name: 'contacts',
        body: q05ContactRound(server, db),
      },
      {
        name: 'devices',
        body: q05DeviceRound(server, fixture.u1, fixture.u2, fixture.directU1U2),
      },
      {
        name: 'agent-transfer',
        body: q05AgentTransferRound(server, db, [
          fixture.u1,
          fixture.u2,
          fixture.u3,
          fixture.u4,
        ]),
      },
      {
        name: 'owner-transfer',
        body: q05OwnerTransferRound(
          server,
          db,
          [fixture.u1, fixture.u2, fixture.u3, fixture.u4],
          fixture.u5,
        ),
      },
      {
        name: 'faults',
        rounds: faultBodies.length,
        body: async (round: number) => {
          const fault = faultBodies[round - 1];
          if (!fault) throw new Error(`未知故障组: ${round}`);
          try {
            await fault.body(round, () => 0.5);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${fault.name}: ${message}`);
          }
        },
      },
    ];

    for (const scenario of scenarios) {
      if (options.scenario && options.scenario !== scenario.name) continue;
      results.push(
        await runScenario(
          scenario.name,
          {
            seed: options.seed,
            rounds: scenario.rounds ?? options.rounds,
            roundFilter: options.round ?? undefined,
            audit: (round) => auditQ05Invariants(db, scenario.name, round),
          },
          scenario.body,
        ),
      );
    }

    if (options.scenario && results.length === 0) {
      throw new Error(`未知场景: ${options.scenario}`);
    }
    if (results.some((result) => result.name === 'file-binding')) printQ05FileStats();
    if (results.some((result) => result.name === 'agent-transfer')) {
      console.log(
        `  agent-transfer 结果分布：交接接受 ${q05AgentTransferStats.acceptSuccesses}/${q05AgentTransferStats.rounds}，旧管理者重发成功 ${q05AgentTransferStats.reissueSuccesses}，确定性重发后失效 ${q05AgentTransferStats.preReissueRevoked}`,
      );
    }
    if (results.some((result) => result.name === 'owner-transfer')) {
      console.log(
        `  owner-transfer 结果分布：解散 ${q05OwnerStats.dissolved}，转让成功 ${q05OwnerStats.transferred}，原 owner 保留 ${q05OwnerStats.ownerRetained}/${q05OwnerStats.rounds}`,
      );
    }
  } finally {
    db.close();
    await server.destroy();
  }

  printFailureDetail();
  writeSummary(options, results, startedAt);
  const stats = scenarioStats();
  console.log(
    `冲突结果分布：task-transfer=${JSON.stringify(stats['task-transfer-race'])} review=${JSON.stringify(stats['review-race'])}`,
  );
  console.log(
    `             contacts=${JSON.stringify(stats.contacts)} devices=${JSON.stringify(stats.devices)}`,
  );
  console.log(
    `             agent-transfer=${JSON.stringify(stats['agent-transfer'])} owner-transfer=${JSON.stringify(stats['owner-transfer'])}`,
  );

  const failed = results.reduce((sum, result) => sum + result.failed, 0);
  const failedScenarios = results.filter((result) => result.failed > 0).length;
  console.log(
    `\nQ05 ${failed === 0 ? 'PASS' : 'FAIL'} · checks=${q05Checks()} · 场景=${results.length} · 失败=${failed} · 失败场景=${failedScenarios} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main().catch((error) => {
  console.error('Q05 运行失败', error);
  process.exitCode = 1;
});
