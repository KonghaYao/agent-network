/**
 * 新 Agent 接入提示词单测：CLI 只下载一次到本地缓存，后续命令复用该路径。
 *
 * 运行：bun scripts/verify-agent-prompt.ts
 */

import { agentConnectPrompt } from '../src/web/lib/agents';
import { check, checkEqual, checksPassed } from './lib/harness';

const origin = 'https://networks.peri-code.dev';
const token = 'ank_prompt_unit_token';
const actorId = 'agt_prompt_unit_actor';
const envPath = `~/.agentnet/agents/${actorId}.env`;
const prompt = agentConnectPrompt(token, actorId, origin);
const lines = prompt.split('\n');

check(
  '提示词准备本地缓存目录',
  prompt.includes('mkdir -p ~/.agentnet'),
);
check(
  '提示词仅在本地缺失时下载 CLI',
  prompt.includes(
    `[ -f ~/.agentnet/agentnet.js ] || curl -fsSL ${origin}/skills/agentnet.js -o ~/.agentnet/agentnet.js`,
  ),
);
checkEqual('提示词只包含一次下载命令', prompt.split('curl -fsSL').length - 1, 1);
check(
  '提示词说明契约不兼容时删除重下',
  prompt.includes('契约不兼容') && prompt.includes('rm ~/.agentnet/agentnet.js'),
);
check(
  '--help 使用本地缓存路径',
  prompt.includes('bun ~/.agentnet/agentnet.js --help'),
);
check(
  'skills 使用本地缓存路径',
  prompt.includes('bun ~/.agentnet/agentnet.js skills --harness'),
);
check(
  'login/monitor/up 使用本地缓存路径',
  prompt.includes(`bun ~/.agentnet/agentnet.js --env-file ${envPath} --expect-actor ${actorId} login`) &&
    prompt.includes(`bun ~/.agentnet/agentnet.js --env-file ${envPath} --expect-actor ${actorId} monitor --harness`) &&
    prompt.includes(`或一步登录并监听：bun ~/.agentnet/agentnet.js --env-file ${envPath} --expect-actor ${actorId} up --harness`),
);
checkEqual('提示词包含五条本地 bun 命令', lines.flatMap((line) => line.match(/bun \S+/gu) ?? []).length, 5);
check(
  '没有裸相对路径可执行命令',
  !prompt.includes('bun agentnet.js '),
);
check(
  '保留凭据与环境文件约束',
  prompt.includes(`AGENTNET_TOKEN=${token}`) &&
    prompt.includes(`AGENTNET_EXPECT_ACTOR=${actorId}`) &&
    prompt.includes('chmod 600 ') &&
    prompt.includes('--env-file ' + envPath) &&
    prompt.includes('勿发群'),
);

console.log('\n生成的提示词前 6 行：');
console.log(lines.slice(0, 6).map((line) => `  ${line}`).join('\n'));
console.log(`\nAgent prompt units: ${checksPassed()} checks passed`);
