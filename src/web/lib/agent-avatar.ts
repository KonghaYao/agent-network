/**
 * 账号首字头像的品牌图标映射。
 *
 * 规则与 legacy `chat-avatar-script.ts` 保持一致：按名称关键词匹配本地
 * `public/agent-icons`，未命中或名称为 `peri` 时回退首字；人类身份只匹配
 * `anyKind` 规则（用户提供的专用头像），Agent 身份才匹配品牌图标。
 */
export interface AccountAvatarSpec {
  src: string;
  brand: string;
  mono: boolean;
}

interface AvatarRule {
  keys: string[];
  file: string;
  brand: string;
  mono: boolean;
  anyKind?: boolean;
}

const RULES: AvatarRule[] = [
  // 用户提供的专用头像，优先于品牌图标规则。
  { keys: ['tibo'], file: 'tibo.png', brand: 'Tibo', mono: false },
  { keys: ['poteto'], file: 'poteto.png', brand: 'poteto', mono: false, anyKind: true },
  { keys: ['konghayao'], file: 'konghayao.png', brand: 'KonghaYao', mono: false, anyKind: true },
  { keys: ['codex'], file: 'codex-color.svg', brand: 'Codex', mono: false },
  { keys: ['claude'], file: 'claude-color.svg', brand: 'Claude', mono: false },
  { keys: ['anthropic'], file: 'anthropic.svg', brand: 'Anthropic', mono: true },
  { keys: ['openai', 'gpt', 'chatgpt'], file: 'openai.svg', brand: 'OpenAI', mono: true },
  { keys: ['gemini', 'google', 'bard'], file: 'gemini-color.svg', brand: 'Gemini', mono: false },
  { keys: ['deepseek'], file: 'deepseek-color.svg', brand: 'DeepSeek', mono: false },
  { keys: ['qwen', '通义', '千问'], file: 'qwen-color.svg', brand: 'Qwen', mono: false },
  { keys: ['grok'], file: 'grok.svg', brand: 'Grok', mono: true },
  { keys: ['xai'], file: 'xai.svg', brand: 'xAI', mono: true },
  { keys: ['mistral'], file: 'mistral-color.svg', brand: 'Mistral', mono: false },
  { keys: ['perplexity'], file: 'perplexity-color.svg', brand: 'Perplexity', mono: false },
  { keys: ['cursor'], file: 'cursor.svg', brand: 'Cursor', mono: true },
  { keys: ['copilot', 'github'], file: 'githubcopilot.svg', brand: 'GitHub Copilot', mono: true },
  { keys: ['meta', 'llama'], file: 'meta-color.svg', brand: 'Meta', mono: false },
];

/** 名称关键词 → 本地头像；未命中或名称为 peri 时返回 null，保留首字。 */
export function accountAvatarFor(
  name: string,
  kind: 'human' | 'agent',
): AccountAvatarSpec | null {
  const normalized = String(name || '')
    .toLowerCase()
    .replace(/\s+/gu, '');
  if (!normalized || normalized.startsWith('peri')) return null;
  const includeBrandIcons = kind === 'agent';
  for (const rule of RULES) {
    if (!includeBrandIcons && rule.anyKind !== true) continue;
    if (rule.keys.some((key) => normalized.includes(key))) {
      return { src: `/agent-icons/${rule.file}`, brand: rule.brand, mono: rule.mono };
    }
  }
  return null;
}
