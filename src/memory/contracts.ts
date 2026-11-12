/**
 * WeBots v3 Memory 公共契约入口（MF01）。
 *
 * 对外统一从本模块导入；内部按身份/来源、经历/证据、召回/宿主与 schema
 * 拆分，避免单文件超过 1000 行。这里只做 re-export，不引入运行时逻辑。
 *
 * 已冻结的关键裁决：
 * - 同一 Agent 的私聊与每个群按 origin room + member generation 隔离；
 *   默认不跨房披露，跨房必须显式 grant 且重新核对当前权限。
 * - 未认领 Agent 使用 self_owned 空间；首次认领/管理转让递增 ownership_epoch
 *   并切换活动空间，旧私有历史不自动交给新 owner。
 * - lookup 结果永不携带注入许可；auto 只允许 related/task，且必须绑定准确
 *   recall target；只有 claim 后才生成 bound Context。
 * - 宿主等级由服务端签发；strict schema 拒绝客户端自报 space、provider bank、
 *   verified/trusted 或裸 through_seq。
 */
export * from './contracts-core';
export * from './experience-contracts';
export * from './recall-contracts';
export * from './schema-contracts';
export * from './host-protocol';
