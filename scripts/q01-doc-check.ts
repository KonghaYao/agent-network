/**
 * Q01-T02：文档、工具面与 CLI 覆盖一致性检查。
 *
 * 运行前需要本地服务（默认 `AGENTNET_URL=http://127.0.0.1:8792`）。
 * 检查：
 * - `tools/list` 为 142 个唯一工具（Human/Agent 视角；秘书服务身份只有 4 个）；
 * - README/CLAUDE/功能矩阵/代码索引/技能/CLI/Harness 只引用已注册工具；
 * - `public/skills` 不再包含 `.sh`，文档不再出现旧 shell 脚本名；
 * - Harness 指南不再把长期 token 二维码或隐式 @ 当作默认路径；
 * - `src/mcp/skill.ts` 的 SKILL.md 正文与 `skills/list` digest / `resources/read` 一致，
 *   以及与静态技能的共享 section digest 一致。
 *
 * 本脚本只读文件，不写文档、不调用业务写工具。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL_MARKDOWN, SKILL_URI } from '../src/mcp/skill';
import { check, checkEqual, checksPassed, rawRpc } from './lib/harness';

const ROOT = join(import.meta.dir, '..');
const DOC_FILES = [
  'README.md',
  'CLAUDE.md',
  'docs/code-index.md',
  'docs/feature-matrix.md',
  'src/mcp/skill.ts',
  'client/cli.ts',
  'client/credentials.ts',
  'client/harness-guides.ts',
  'public/skills/agent-network-skills.md',
  ...readdirSync(join(ROOT, 'public/skills'))
    .filter((name) => name.startsWith('harness-') && name.endsWith('.md'))
    .map((name) => `public/skills/${name}`),
];

/** 旧 shell 包装已删除；一个发布周期内只保留 410 路由。 */
const OLD_SCRIPT_PATTERN =
  /(?:agentnet|agent_tasks|claude-watch|codex-watch|peri-watch|dsh-watch|other-sentinel)\.sh/u;

const RETIRED_TASK_TOOL_PATTERN = /network_task_[a-z_]*/u;

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function toolNames(text: string): string[] {
  return [...text.matchAll(/\b(?:network_[a-z_]+|drive_file_info)\b/gu)]
    .map((match) => match[0])
    .filter((name) => !name.endsWith('_'));
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /u);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function digest(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

const toolsResponse = await rawRpc('tools/list');
checkEqual('tools/list HTTP 状态', toolsResponse.status, 200);
const tools =
  (toolsResponse.body.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? [];
const toolSet = new Set(tools.map((tool) => tool.name).filter((name): name is string => !!name));
checkEqual('tools/list 工具数为 142', toolSet.size, 142);
checkEqual('tools/list 无重复名称', tools.length, 142);

const unknown: string[] = [];
for (const file of DOC_FILES) {
  const text = read(file);
  for (const name of toolNames(text)) {
    if (!toolSet.has(name)) unknown.push(`${file}: ${name}`);
  }
}
if (unknown.length > 0) console.error(unknown.join('\n'));
checkEqual('文档/技能/CLI 没有引用未注册工具', unknown.length, 0);

const skillFiles = readdirSync(join(ROOT, 'public/skills'));
const shellFiles = skillFiles.filter((name) => name.endsWith('.sh'));
checkEqual('public/skills 不含 .sh', shellFiles.length, 0);

const legacyScriptRefs: string[] = [];
for (const file of DOC_FILES) {
  const match = read(file).match(OLD_SCRIPT_PATTERN);
  if (match) legacyScriptRefs.push(`${file}: ${match[0]}`);
}
if (legacyScriptRefs.length > 0) console.error(legacyScriptRefs.join('\n'));
checkEqual('文档/技能/CLI 不再出现旧 shell 脚本名', legacyScriptRefs.length, 0);

const cli = read('client/cli.ts');
check('CLI 不暴露 task 子命令', !cli.includes(".command('task')"));
check(
  'CLI 暴露 monitor --harness',
  cli.includes(".command('monitor')") && cli.includes("'--harness <name>'"),
);
check('CLI 不引用旧任务工具', !RETIRED_TASK_TOOL_PATTERN.test(cli));
check('CLI 不声明旧任务状态命令', !cli.includes('--task ') && !cli.includes('task_id'));
check(
  'CLI 暴露显式凭据与身份选项',
  cli.includes("'--env-file <path>'") &&
    cli.includes("'--token-file <path>'") &&
    cli.includes("'--expect-actor <actor_id>'"),
);
check(
  'CLI 区分 credentials_required 与 actor_required',
  cli.includes("'--env-file <path>'") &&
    read('client/credentials.ts').includes("'credentials_required'") &&
    read('client/credentials.ts').includes("'actor_required'") &&
    cli.includes('AGENTNET_EXPECT_ACTOR'),
);
for (const file of [
  'README.md',
  'client/harness-guides.ts',
  'src/mcp/skill.ts',
  'public/skills/agent-network-skills.md',
]) {
  const text = read(file);
  check(
    `${file} 使用每 Agent 自己的 env 文件`,
    text.includes('~/.agentnet/agents/<actor_id>.env') &&
      text.includes('--env-file') &&
      text.includes('--expect-actor'),
  );
  check(`${file} 说明仅宿主环境变量不足`, text.includes('credentials_required'));
}
const monitorScript = read('scripts/webbots-monitor.sh');
check(
  'webbots-monitor.sh 从 AGENTNET_ENV_FILE / AGENTNET_ACTOR 读取凭据与身份',
  monitorScript.includes('AGENTNET_ENV_FILE') &&
    monitorScript.includes('AGENTNET_ACTOR') &&
    monitorScript.includes('--env-file') &&
    monitorScript.includes('--expect-actor'),
);
check(
  'webbots-monitor.sh 不写死共享路径或 actor',
  !monitorScript.includes('webbots-agent.env') &&
    !/agt_[0-9a-f]{32}/u.test(monitorScript),
);

const harness = DOC_FILES.filter((file) => file.startsWith('public/skills/harness-'));
for (const file of harness) {
  const text = read(file);
  check(`${file} 不以长期 token 二维码为默认入口`, !text.includes('/#t=') && !text.includes('长期 token 二维码'));
  check(`${file} 不把隐式 @ 当默认派活路径`, !text.includes('默认 @') && !text.includes('自动 @'));
}
const skillText = read('public/skills/agent-network-skills.md');
check('静态技能包含显式 invoke 规则', skillText.includes('显式 `invoke`') || skillText.includes('显式 invoke'));
check('静态技能包含设备配对', skillText.includes('network_device_pairing_create'));
check('静态技能不再包含消息式 Task 工具', !RETIRED_TASK_TOOL_PATTERN.test(skillText));
check(
  '静态技能包含用户名搜索与 actor_id 核对流程',
  skillText.includes('network_contact_search') &&
    skillText.includes('actor.actor_id') &&
    skillText.includes('network_contact_request'),
);

const skillsResponse = await rawRpc('skills/list');
checkEqual('skills/list HTTP 状态', skillsResponse.status, 200);
const entries =
  (skillsResponse.body.result as
    | { skills?: Array<{ uri?: string; resources?: Array<{ uri?: string; digest?: string }> }> }
    | undefined)?.skills ?? [];
checkEqual('skills/list 返回 1 个技能', entries.length, 1);
const entry = entries[0];
checkEqual('技能 URI 与源文件一致', entry?.uri, SKILL_URI);
const resource = entry?.resources?.find((item) => item.uri === SKILL_URI);
checkEqual('SKILL.md digest 与 src/mcp/skill.ts 正文一致', resource?.digest, `sha256:${digest(SKILL_MARKDOWN)}`);

const skillRead = await rawRpc('resources/read', { uri: SKILL_URI }, { headers: { 'mcp-name': SKILL_URI } });
checkEqual('resources/read HTTP 状态', skillRead.status, 200);
const contents =
  (skillRead.body.result as { contents?: Array<{ text?: string }> } | undefined)?.contents ?? [];
checkEqual('resources/read 正文与 src/mcp/skill.ts 一致', contents[0]?.text, SKILL_MARKDOWN);

checkEqual(
  '静态/主技能 Markdown 写法 section digest 一致',
  digest(section(skillText, '### Markdown 写法')),
  digest(section(SKILL_MARKDOWN, '### Markdown 写法')),
);
checkEqual(
  '静态/主技能 multitask section digest 一致',
  digest(section(skillText, '## multitask 异步分发')),
  digest(section(SKILL_MARKDOWN, '## multitask 异步分发')),
);

console.log(`Q01 文档/工具一致性检查通过: ${checksPassed()} 项`);
