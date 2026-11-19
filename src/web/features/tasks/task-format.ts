/** Task dock、预览与 Trace 共用的时间格式；不改变任何业务状态。 */
export function taskTimeLabel(value: string | null | undefined): string {
  if (!value) return '';
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const elapsed = Date.now() - timestamp;
  if (elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000) {
    const minutes = Math.floor(elapsed / 60_000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    return `${Math.floor(minutes / 60)} 小时前`;
  }
  const date = new Date(timestamp);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() === new Date().getFullYear()) return `${day} ${time}`;
  return `${date.getFullYear()}年${day} ${time}`;
}
