/** Protocol/business acceptance against a fresh temporary SQLite server; never production. */
import { startServer } from './verify-web';

const targets: Record<string, string> = {
  protocol: 'scripts/verify-protocol.ts',
  acceptance: 'scripts/acceptance.ts',
};
const target = targets[process.argv[2] || ''];
if (!target) throw new Error('Usage: bun scripts/verify-isolated.ts protocol|acceptance');
const server = await startServer();
try {
  const child = Bun.spawn([process.execPath, target], {
    env: { ...process.env, AGENTNET_URL: server.base,
      AGENT_PRESENCE_GRACE_MS: '1200', AGENT_PRESENCE_ACTIVITY_TTL_MS: '1200' },
    stdout: 'inherit', stderr: 'inherit',
  });
  process.exitCode = await child.exited;
} finally {
  await server.stop();
}
