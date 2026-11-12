/**
 * MF10 故障注入子进程：本地意图已提交，在外部适配器响应前/后强制退出。
 *
 * 运行：bun scripts/lib/memory-integration-child.ts <db-path> <local-path> <mode>
 * mode=before_external  作业已领取，适配器调用前退出（外部无记录）
 * mode=after_external   适配器已写入本地后端，本地完成前退出（无 provider ref）
 * mode=after_external_ref 远端已写入且 provider ref 已落库，本地完成前退出
 */
import { MemoryRuntime } from '../../src/memory/runtime';
import { LocalMemoryAdapter } from '../../src/memory/adapters/local';
import type {
  EnsureSpaceRequest,
  EnsureSpaceResult,
  JobStatusRequest,
  JobStatusResult,
  MemoryAdapter,
  MemoryAdapterCapabilities,
  RemoveRequest,
  RemoveResult,
  RetainRequest,
  RetainResult,
  SearchRequest,
  SearchResult,
} from '../../src/memory/adapters/types';
import { MEMORY_INTEGRATION_AT, seedMemoryAdmission } from './memory-admission-fixture';

const AT = MEMORY_INTEGRATION_AT;
type Mode = 'before_external' | 'after_external' | 'after_external_ref';

class CrashAdapter implements MemoryAdapter {
  constructor(
    private readonly delegate: LocalMemoryAdapter,
    private readonly mode: Mode,
    private readonly d1: D1Database,
  ) {}

  capabilities(): MemoryAdapterCapabilities {
    return this.delegate.capabilities();
  }

  ensureSpace(request: EnsureSpaceRequest): Promise<EnsureSpaceResult> {
    return this.delegate.ensureSpace(request);
  }

  async retain(request: RetainRequest): Promise<RetainResult> {
    if (this.mode === 'before_external') process.exit(0);
    const result = await this.delegate.retain(request);
    if (this.mode === 'after_external') {
      this.delegate.close();
      process.exit(0);
    }
    const job = await this.d1
      .prepare("SELECT job_id FROM memory_jobs WHERE operation_type = 'retain' ORDER BY created_at DESC LIMIT 1")
      .first<{ job_id: string }>();
    if (!job || !result.job_ref) process.exit(2);
    await this.d1
      .prepare(
        `UPDATE memory_jobs
            SET provider_job_id = ?, stage = 'source_applied', updated_at = ?
          WHERE job_id = ?`,
      )
      .bind(result.job_ref.provider_job_id, AT + 600, job.job_id)
      .run();
    this.delegate.close();
    process.exit(0);
  }

  search(request: SearchRequest): Promise<SearchResult> {
    return this.delegate.search(request);
  }

  remove(request: RemoveRequest): Promise<RemoveResult> {
    return this.delegate.remove(request);
  }

  jobStatus(request: JobStatusRequest): Promise<JobStatusResult> {
    return this.delegate.jobStatus(request);
  }
}

async function main(dbPath: string, localPath: string, mode: Mode): Promise<void> {
  const fixture = await seedMemoryAdmission(dbPath);
  const delegate = new LocalMemoryAdapter({ path: localPath, now: () => AT + 500 });
  const runtime = new MemoryRuntime(fixture.env.d1, {
    adapter: new CrashAdapter(delegate, mode, fixture.env.d1),
    instanceId: fixture.instanceId,
    capture: true,
    now: () => AT + 500,
  });
  await runtime.start();
  await runtime.tick();
  // 正常情况下不应走到这里：故障适配器在 retain 内退出。
  process.exit(4);
}

const [dbPath, localPath, rawMode] = process.argv.slice(2);
if (!dbPath || !localPath || !rawMode) {
  console.error('usage: bun scripts/lib/memory-integration-child.ts <db-path> <local-path> <mode>');
  process.exit(2);
}
if (rawMode !== 'before_external' && rawMode !== 'after_external' && rawMode !== 'after_external_ref') {
  console.error(`unknown mode: ${rawMode}`);
  process.exit(2);
}
await main(dbPath, localPath, rawMode);
