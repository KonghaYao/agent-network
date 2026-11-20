/**
 * Vite define 注入的构建期常量。
 *
 * 发布构建在 Vite 启动前生成两个 Bun 模块的哈希 URL；开发构建为空，
 * 客户端回退到固定别名 `/assets/*`。`__WEB_BUILD_NONCE__` 只用于诊断，
 * 同时让每次真实构建的入口字节不同，便于 A/B 切换验证。
 *
 * 生产/开发判断使用 Vite 内建的 `import.meta.env`；其 `PROD` 与 `MODE`
 * 由 Vite 静态替换，类型来自 Bun 的 `ImportMetaEnv`。
 */
declare const __WEB_MARKDOWN_URL__: string;
declare const __WEB_DRAWBOARD_URL__: string;
declare const __WEB_BUILD_NONCE__: string;
