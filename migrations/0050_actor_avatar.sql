-- 头像文件引用：只保存 MCPP Files 的 file_id，不复制文件元数据。
--
-- - 头像由 `network_profile_update { avatar_file_id }` 写入，只允许当前 actor
--   上传、公开、未过期的光栅图片草稿。
-- - 维护任务把 `actors.avatar_file_id` 视为长期引用：被引用的 drive 文件保持
--   retained=1，不参与 TTL 软删与载荷回收；替换/清除时旧引用自然消失。
-- - 不新增 file_references 行，也不复用 artifact/room 保留语义。

ALTER TABLE actors ADD COLUMN avatar_file_id TEXT NULL;
