/**
 * MF11：分群经历、输入选择与稀疏覆盖的统一入口。
 *
 * 实现按职责拆分，保持单文件低于仓库 1000 行上限：
 * - experience-source.ts：准确表示、选取、去重键与 SourceSelection；
 * - experience-read.ts：稀疏经历列表/get、当前可用性与 derived frontier；
 * - experience-record.ts：authored 发布记录与 curated 人工资料。
 *
 * 所有能力都只处理“可供输入/已接纳经历”，不在这里生成 MCP 工具或 UI。
 */
export * from './experience-source';
export * from './experience-read';
export * from './experience-record';
