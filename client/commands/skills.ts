/** `skills list` / `skills get` 使用 MCP SEP-2640 技能面；`skills --harness` 是本地接入指南。 */

import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import { HARNESS_GUIDES, harnessListText, renderHarnessGuide } from '../harness-guides';
import { asArray, asRecord, asString, emit, line } from '../output';

interface SkillEntry {
  uri: string;
  frontmatter: {
    name?: string;
    description?: string;
  };
  resources?: { uri: string; digest?: string }[];
}

function skillEntryOf(value: unknown): SkillEntry {
  const record = asRecord(value);
  return {
    uri: asString(record.uri),
    frontmatter: asRecord(record.frontmatter) as SkillEntry['frontmatter'],
    resources: asArray(record.resources).map((item) => {
      const resource = asRecord(item);
      return { uri: asString(resource.uri), digest: asString(resource.digest) };
    }),
  };
}

export interface SkillsListOptions {
  cursor?: string;
}

export async function skillsList(
  client: McpClient,
  config: ResolvedConfig,
  options: SkillsListOptions,
): Promise<void> {
  const cursor = options.cursor;
  const result = await client.rpc('skills/list', cursor ? { cursor } : {});
  emit(config, result, (value) => {
    const skills = asArray(value.skills).map(skillEntryOf);
    line(`SKILLS (${skills.length})`);
    for (const skill of skills) {
      line(`- ${skill.frontmatter.name ?? '(未命名)'}  ${skill.uri}`);
      if (skill.frontmatter.description) line(`  ${skill.frontmatter.description}`);
      for (const resource of skill.resources ?? []) {
        line(`  resource ${resource.uri}${resource.digest ? ` ${resource.digest}` : ''}`);
      }
    }
    // SEP-2640 当前不分页；服务端未来返回游标时按同一约定展示。
    if ('nextCursor' in value || 'next_cursor' in value || 'has_more' in value) {
      line(
        `next_cursor=${asString(value.nextCursor, asString(value.next_cursor, '-'))} has_more=${String(
          value.has_more === true,
        )}`,
      );
    }
  });
}

/** 支持按 frontmatter.name、URI 或 URI 末段（技能 id）查找。 */
function resolveSkill(skills: SkillEntry[], query: string): SkillEntry {
  const exactUri = skills.find((skill) => skill.uri === query);
  if (exactUri) return exactUri;
  const byName = skills.find((skill) => skill.frontmatter.name === query);
  if (byName) return byName;
  const bySegment = skills.find((skill) => {
    const segments = skill.uri.split('/');
    return segments[segments.length - 1] === query || segments[segments.length - 2] === query;
  });
  if (bySegment) return bySegment;
  const available = skills.map((skill) => skill.frontmatter.name ?? skill.uri).join(', ');
  throw new CliError(`未找到技能：${query}${available ? `；可用：${available}` : ''}`);
}

export async function skillsGet(
  client: McpClient,
  config: ResolvedConfig,
  query: string | undefined,
): Promise<void> {
  if (!query) {
    throw new CliError('用法：agentnet skills get <name|id>（运行 agentnet skills get --help 查看示例）');
  }
  const list = await client.rpc('skills/list', {});
  const skill = resolveSkill(asArray(list.skills).map(skillEntryOf), query);
  const got = await client.rpc('skills/get', { uri: skill.uri });
  const entry = got.skill ? skillEntryOf(got.skill) : skill;
  const text = await client.readResource(entry.uri);
  const value = { skill: entry, text };
  emit(config, value, (result) => {
    line(`技能: ${result.skill.frontmatter.name ?? '(未命名)'}`);
    line(`URI: ${result.skill.uri}`);
    if (result.skill.frontmatter.description) {
      line(`描述: ${result.skill.frontmatter.description}`);
    }
    for (const resource of result.skill.resources ?? []) {
      line(`资源: ${resource.uri}${resource.digest ? ` ${resource.digest}` : ''}`);
    }
    line('---');
    line(result.text);
  });
}

/**
 * `skills --harness <name>`：纯本地文本，不要求 URL/token，也不访问 MCP。
 * 这是给 Agent 抄的接入清单，不替代 `skills list/get` 的 MCP 技能发现。
 */
export function skillsHarness(harness: string | undefined, json: boolean): void {
  if (!harness) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            harnesses: Object.keys(HARNESS_GUIDES),
            text: harnessListText(),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(harnessListText());
    return;
  }
  if (!(harness in HARNESS_GUIDES)) {
    throw new CliError(
      `未知 harness：${harness}（支持：${Object.keys(HARNESS_GUIDES).join('|')}；运行 agentnet skills --help 查看示例）`,
    );
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          harness,
          text: renderHarnessGuide(harness),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(renderHarnessGuide(harness));
}
