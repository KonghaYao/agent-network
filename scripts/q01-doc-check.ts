/**
 * Q01-T02：文档、工具面与 CLI 覆盖一致性检查。
 *
 * 运行前需要本地服务（默认 `AGENTNET_URL=http://127.0.0.1:8792`）。
 * 检查：
 * - `tools/list` 为 113 个唯一工具；
 * - README/CLAUDE/功能矩阵/代码索引/技能/CLI/Harness 只引用已注册工具；
 * - `agent_tasks.sh` 覆盖消息式 Task 的 mark/unmark/summaries/trace/search；
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
  'public/skills/agent-network-skills.md',
  'public/skills/agentnet.sh',
  'public/skills/agent_tasks.sh',
  ...readdirSync(join(ROOT, 'public/skills'))
    .filter((name) => name.startsWith('harness-') && name.endsWith('.md'))
    .map((name) => `public/skills/${name}`),
];

const REQUIRED_CLI = [
  'mark)',
  'unmark)',
  'summaries)',
  'trace)',
  'search)',
];

const RETIRED_TASK_TOOL_PATTERN =
  /network_task_(?:summary(?!ies)|list|get|create|offer|accept|decline|claim|cancel|retry|progress|block|resume|transfer|handoff|submit|submission|review|reviewer|execution)[a-z_]*/u;

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

const RETIRED_TASK_TOOLS = new Set([
  'network_task_add',
  'network_task_list_get',
  'network_task_complete',
  'network_task_fail',
  'network_task_update',
  'network_task_delete',
]);

function toolNames(text: string): string[] {
  return [...text.matchAll(/\b(?:network_[a-z_]+|drive_file_info)\b/gu)]
    .map((match) => match[0])
    .filter((name) => !name.endsWith('_') && !RETIRED_TASK_TOOLS.has(name));
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
checkEqual('tools/list 工具数为 113', toolSet.size, 113);
checkEqual('tools/list 无重复名称', tools.length, 113);

const unknown: string[] = [];
for (const file of DOC_FILES) {
  const text = read(file);
  for (const name of toolNames(text)) {
    if (!toolSet.has(name)) unknown.push(`${file}: ${name}`);
  }
}
if (unknown.length > 0) console.error(unknown.join('\n'));
checkEqual('文档/技能/CLI 没有引用未注册工具', unknown.length, 0);

const cli = read('public/skills/agent_tasks.sh');
for (const command of REQUIRED_CLI) {
  check(`agent_tasks.sh 覆盖 ${command}`, cli.includes(`  ${command} cmd_`));
}
check('agent_tasks.sh 不引用旧任务工具', !RETIRED_TASK_TOOL_PATTERN.test(cli));
check('agent_tasks.sh 不声明旧任务状态命令', !cli.includes('--task ') && !cli.includes('task_id'));

const harness = DOC_FILES.filter((file) => file.startsWith('public/skills/harness-'));
for (const file of harness) {
  const text = read(file);
  check(`${file} 不以长期 token 二维码为默认入口`, !text.includes('/#t=') && !text.includes('长期 token 二维码'));
  check(`${file} 不把隐式 @ 当默认派活路径`, !text.includes('默认 @') && !text.includes('自动 @'));
}
const skillText = read('public/skills/agent-network-skills.md');
check('静态技能包含显式 invoke 规则', skillText.includes('显式 `invoke`') || skillText.includes('显式 invoke'));
check('静态技能包含设备配对', skillText.includes('network_device_pairing_create'));
check('静态技能包含消息式 Task 摘要与 Trace', skillText.includes('network_task_summaries') && skillText.includes('network_task_trace'));

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
