/**
 * Agent 品牌头像映射片段。
 *
 * 按显示名称关键词匹配本地 `public/agent-icons` 下的图标；
 * 其中 `tibo.png`、`poteto.png`、`konghayao.png` 为用户提供的专用头像，
 * 不属于 LobeHub/MIT；未命中或名称为 `peri` 时返回 null，继续使用首字/颜色头像。
 * 品牌图标只用于 Agent，用户提供的 `poteto`/`konghayao` 对人类与 Agent 都生效。
 * 由 `chatClientScript` 拼进主脚本共享作用域，因此不使用模块 import。
 *
 * 图标只在本地加载，运行时不请求 unpkg 等外链。彩色图标保留品牌配色；
 * 单色图标作为 `<img>` 加载时无法继承 `currentColor`，浏览器按黑色渲染，
 * 因此样式统一给图标白/浅色底。图片加载失败时移除 `<img>`，容器内保留的
 * 首字自然回退，不显示破图。
 */
export const CHAT_AVATAR_SCRIPT = `
const AGENT_AVATAR_RULES = [
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
  { keys: ['meta', 'llama'], file: 'meta-color.svg', brand: 'Meta', mono: false }
];

/**
 * 名称关键词 → 本地头像；未命中或名称为 peri 时返回 null，保留首字 fallback。
 * kind 省略（映射自测）时等同 Agent；人类/会话等非 Agent 只匹配 anyKind 规则。
 */
function agentAvatarFor(name, kind) {
  const normalized = String(name || '').toLowerCase().replace(/\\s+/gu, '');
  if (!normalized || normalized.indexOf('peri') === 0) return null;
  const includeBrandIcons = kind === undefined || kind === 'agent';
  for (const rule of AGENT_AVATAR_RULES) {
    if (!includeBrandIcons && rule.anyKind !== true) continue;
    for (const key of rule.keys) {
      if (normalized.indexOf(key) >= 0) {
        return { src: '/agent-icons/' + rule.file, brand: rule.brand, mono: rule.mono };
      }
    }
  }
  return null;
}

/** 清除上一次匹配的图片与品牌标记；账号头像等复用节点改名后需要重新匹配。 */
function resetAgentAvatar(element) {
  if (!element) return;
  const image = element.querySelector('img.avatar-img');
  if (image) image.remove();
  element.classList.remove('avatar-icon', 'avatar-mono');
  delete element.dataset.brand;
  element.style.background = '';
}

/** 在已创建的头像容器内叠加品牌/用户头像；失败时移除图片，首字仍可见。 */
function applyAgentAvatar(element, name, kind) {
  resetAgentAvatar(element);
  const brand = agentAvatarFor(name, kind);
  if (!brand) return false;
  element.classList.add('avatar-icon');
  element.classList.toggle('avatar-mono', brand.mono);
  element.dataset.brand = brand.brand;
  element.textContent = firstChar(name);
  const image = document.createElement('img');
  image.className = 'avatar-img';
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener('error', function () {
    image.remove();
  });
  image.src = brand.src;
  element.append(image);
  return true;
}
`;
