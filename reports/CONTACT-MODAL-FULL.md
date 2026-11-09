# 好友弹窗 full 布局与文案精简

状态：READY_FOR_REVIEW

## 变更

- 好友申请弹窗桌面改为 full 面板：`width: min(1120px, 96vw)`、`height: min(88dvh, 900px)`，两栏铺满，列内容独立滚动。
- 移动端（<760px）铺满可视区：`width: 100%`、`height: 100dvh`、无圆角/外边距。
- 删除“申请只进入独立收件箱……”长说明；好友链接提示压缩为“一次性链接，24 小时内有效；对方登录后直接成为好友。”
- 保留两栏结构、所有 DOM id、好友链接/申请/接收策略行为与服务端契约。

## 验证

- `bun run typecheck`：通过
- `bun run test:web`：2230 项通过（新增 full 宽度与精简文案断言）
- `bun scripts/verify-q04.ts`：173 项通过
- `bun scripts/verify-isolated.ts protocol`：1003 项通过

## 限制

- “full”按好友弹窗布局理解；群历史策略 `member_history_policy=full` 需要群主身份，维护员当前为 member，未直接修改。
- 群历史策略可由群主调用 `network_room_policy_set { member_history_policy: 'full', expected_policy_revision }`；如需 Web 开关另行实现。
