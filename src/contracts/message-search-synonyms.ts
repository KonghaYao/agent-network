/**
 * 模糊搜索的离线近义词扩展。
 *
 * 词表是仓库内静态常量，不依赖外部模型或网络；每个语义组只在查询归一化后
 * 与组内某个词完全相等时触发，把组内其他归一化词作为额外候选。这里只产出
 * 纯文本候选，不读数据库、不改变权限，也不把词表内容写进日志。
 */

import { LIMITS } from './limits';
import {
  findFuzzyMatch,
  findNormalizedSubstringMatch,
  normalizeFuzzyQuery,
  type SearchMatchRange,
} from './message-search-match';

/** 含同义词扩展的 fuzzy matcher 版本；变化时必须让旧 fuzzy 游标失效。 */
export const FUZZY_MATCHER_VERSION = 'mfuzzy-v2';

/** 同义词词表版本；词表升级时旧游标同样失效。 */
export const MESSAGE_SEARCH_SYNONYM_VERSION = 'syn-v1';

/**
 * fuzzy 游标绑定的算法版本。
 *
 * 词表版本单独并入游标 scope，词表升级或匹配语义变化都会让旧游标失效；
 * 不能只靠 `FUZZY_MATCHER_VERSION`，否则词表更新后旧游标仍会沿用旧结果。
 */
export const FUZZY_CURSOR_VERSION = `${FUZZY_MATCHER_VERSION}:${MESSAGE_SEARCH_SYNONYM_VERSION}`;

/**
 * 常见中文聊天/技术说法的语义组。
 *
 * 组内按原文书写，加载时统一归一化；超过码点下限的词才参与匹配，
 * 避免「慢」「页」这类单字把结果泛化到无关消息。
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['拉不动', '拖拽失效', '无法拖动', '拖动不了', '不能拖动', '拖不动', '拖动失败'],
  ['发版', '发布', '上线', '发新版本', '版本发布', '部署'],
  ['报错', '错误', '异常', '出错', '报错了', '错误信息'],
  ['卡住', '卡死', '无响应', '未响应', '卡顿', '没有响应'],
  ['删除', '移除', '删掉', '删了', '去掉'],
  ['登录', '登陆', '登入'],
  ['退出', '登出', '退出登录'],
  ['搜索', '查找', '检索', '查询', '搜一下'],
  ['文件', '附件'],
  ['图片', '图像', '照片'],
  ['配置', '设置', '设定'],
  ['启动', '开启', '打开', '启动应用'],
  ['关闭', '关掉', '关闭应用'],
  ['崩溃', '闪退', '崩了', '挂了'],
  ['内存泄漏', '内存泄露', '内存溢出'],
  ['密码', '口令'],
  ['账号', '账户', '帐号'],
  ['好友', '联系人', '朋友'],
  ['群聊', '群组', '群'],
  ['私聊', '单聊', '私信'],
  ['修复', '修好', '解决', '修了'],
  ['更新', '升级', '迭代'],
  ['创建', '新建', '新增', '建立'],
  ['重试', '再试', '重新尝试', '重试一次'],
  ['失败', '不成功', '没成功'],
  ['缓慢', '很慢', '太慢'],
  ['上传', '传上去', '上传文件'],
  ['下载', '下下来', '下载文件'],
  ['编译', '构建', '打包'],
  ['测试', '验证', '校验', '检查'],
  ['问题', 'bug', '缺陷', '毛病'],
  ['按钮', '按键', '控件'],
  ['页面', '界面', '视图'],
  ['超时', '超时了', 'timeout'],
];

function normalizeTerm(term: string): string | null {
  const normalized = normalizeFuzzyQuery(term);
  return Array.from(normalized).length >= LIMITS.messageSearchSynonymMinCodePoints
    ? normalized
    : null;
}

const NORMALIZED_GROUPS: readonly (readonly string[])[] = SYNONYM_GROUPS.map((group) => {
  const terms: string[] = [];
  for (const term of group) {
    const normalized = normalizeTerm(term);
    if (normalized === null || terms.includes(normalized)) continue;
    terms.push(normalized);
    if (terms.length >= LIMITS.messageSearchSynonymGroupMax) break;
  }
  return terms;
}).filter((group) => group.length > 0);

/**
 * 返回归一化查询的同义词候选（不含原查询）。
 *
 * 只有查询本身是某个语义组成员时才扩展；每个词都满足最小码点数，
 * 总数受 `messageSearchSynonymExpansionMax` 约束，重复项按首次出现去重。
 */
export function expandFuzzyQuery(normalizedQuery: string): string[] {
  const expansions: string[] = [];
  for (const group of NORMALIZED_GROUPS) {
    if (!group.includes(normalizedQuery)) continue;
    for (const term of group) {
      if (term === normalizedQuery || expansions.includes(term)) continue;
      expansions.push(term);
      if (expansions.length >= LIMITS.messageSearchSynonymExpansionMax) return expansions;
    }
  }
  return expansions;
}

/** fuzzy 的匹配顺序：原查询优先，再按词表顺序尝试同义词。 */
export function fuzzySearchTerms(normalizedQuery: string): string[] {
  return [normalizedQuery, ...expandFuzzyQuery(normalizedQuery)];
}

/**
 * 在正文中按「原查询 → 同义词」顺序匹配，返回首个命中的区间。
 *
 * 原查询保留保序子序列语义；同义词必须归一化后连续命中，避免
 * 「拖拽失效」跨段匹配到「拖把拽到门口，失去效力」这类误召回。
 * 每条消息只返回一次命中，调用方无需再按 message_id 去重。
 */
export function findFuzzyMatchWithSynonyms(
  body: string,
  normalizedQuery: string,
): { term: string; ranges: SearchMatchRange[] } | null {
  for (const [index, term] of fuzzySearchTerms(normalizedQuery).entries()) {
    const ranges =
      index === 0
        ? findFuzzyMatch(body, term)
        : findNormalizedSubstringMatch(body, term);
    if (ranges !== null) return { term, ranges };
  }
  return null;
}
