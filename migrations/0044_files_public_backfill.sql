-- 文件可见性改为默认公开，并回填存量私有文件。
--
-- 产品决定：接受“链接即授权”。fileId 不可猜，但拿到 /f/<fileId> 的人都能读；
-- 新上传与绑定默认 public。需要限制时由上传者或群 owner 调用
-- network_file_publish { public: false } 单独撤销。
--
-- drive_files.state 的 CHECK 约束只允许 'draft' / 'bound' / 'deleted'：
-- - 未删除文件（draft/bound）统一回填为 public，历史裸链立即恢复；
-- - 已删除文件保持原可见性，墓碑语义不变，仍返回 404；
-- - 已经是 public 的行不重复写入。
--
-- 本迁移只改可见性，不改 state、expires_at、retained 或任何文件字节；
-- 公开不延长 TTL，过期/删除仍按原规则返回 404。

UPDATE drive_files
   SET visibility = 'public'
 WHERE visibility = 'private'
   AND state <> 'deleted';
