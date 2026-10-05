-- 保存のたびの中身を残す。1セーブあたり直近 HISTORY_LIMIT（300）件だけを持ち、古いものは保存時に消す。
CREATE TABLE save_history (
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  screenshot TEXT,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (save_id, revision)
);
-- 履歴を始める前の保存は、いまの最新だけを1件目として入れておく。
INSERT INTO save_history (save_id, revision, data, screenshot, saved_at)
  SELECT save_id, revision, data, screenshot, updated_at FROM saves WHERE revision > 0;
