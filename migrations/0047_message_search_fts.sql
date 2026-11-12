-- 消息正文 FTS5 trigram 索引（Phase 4A）。
--
-- 只加速 >=3 个 Unicode 码点的子串搜索；1–2 字符仍由查询层回退 instr。
-- 使用 external content，不复制正文：删除 FTS 表只丢索引，不丢消息。
-- 触发器只同步 body；任务标记、已读等 UPDATE 不触发重建。
--
-- 回填用 rebuild 而不是 INSERT … SELECT：重复执行本迁移不会重复写入，
-- 且以 messages 当前内容为准重建索引。

CREATE VIRTUAL TABLE IF NOT EXISTS message_search_fts USING fts5(
  body,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS message_search_fts_ai
AFTER INSERT ON messages
BEGIN
  INSERT INTO message_search_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER IF NOT EXISTS message_search_fts_ad
AFTER DELETE ON messages
BEGIN
  INSERT INTO message_search_fts(message_search_fts, rowid, body)
  VALUES ('delete', old.rowid, old.body);
END;

CREATE TRIGGER IF NOT EXISTS message_search_fts_au
AFTER UPDATE OF body ON messages
BEGIN
  INSERT INTO message_search_fts(message_search_fts, rowid, body)
  VALUES ('delete', old.rowid, old.body);
  INSERT INTO message_search_fts(rowid, body) VALUES (new.rowid, new.body);
END;

INSERT INTO message_search_fts(message_search_fts) VALUES ('rebuild');
