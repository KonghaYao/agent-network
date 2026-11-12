import { chromium } from 'playwright';
import { createFixture } from './fixture';
import { rawTool } from '../verify-web';

async function uploadTextFile(token: string, base: string, name: string, body: string) {
  const bytes = new TextEncoder().encode(body);
  const response = await fetch(base + '/mcp-upload', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'MCPP-Files-Version': '1',
      'content-type': 'text/plain',
      'MCPP-File-Name': encodeURIComponent(name),
      'MCPP-File-Size': String(bytes.length),
    },
    body: bytes,
  });
  if (response.status !== 201) throw new Error('上传失败: HTTP ' + response.status);
  return (await response.json()) as { publicUrl: string };
}

const fixture = await createFixture(['chat']);
const d = fixture.scenarios.chat;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ['--no-sandbox'] });
const results: string[] = [];
const check = (value: unknown, name: string) => { if (!value) throw new Error(name); results.push(name); };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(token => localStorage.setItem('agent-network-token', token), d.me.token);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGEERROR', error.message); });
  page.setDefaultTimeout(15000);
  await page.goto(fixture.base + '/c/' + d.rooms.directWang.room_id);
  await page.locator('#messages .msg').first().waitFor();
  const original = page.locator('#messages .msg').first();
  const originalId = await original.getAttribute('data-message-id');
  await original.getByRole('button', { name: '消息操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '引用', exact: true }).click();
  await page.locator('#body').fill('引用不会丢草稿');
  await page.locator('#room-list a[data-room-id="' + d.rooms.directLi.room_id + '"]').click();
  await page.locator('#messages .msg').first().waitFor();
  check(await page.locator('#composer-reply').isHidden(), '切换会话不串引用');
  await page.locator('#room-list a[data-room-id="' + d.rooms.directWang.room_id + '"]').click();
  await page.getByText('引用 我').count();
  await page.locator('#composer-reply').waitFor();
  check(await page.locator('#body').inputValue() === '引用不会丢草稿', '切回恢复引用草稿');
  await page.locator('#send').click();
  const sent = page.locator('#messages .msg').filter({ has: page.locator('.bubble', { hasText: '引用不会丢草稿' }) });
  await sent.waitFor();
  const quoteText = (await sent.locator('.reply-reference').innerText()).trim();
  check(quoteText.includes('明天下午三点见') && !quoteText.includes('查看上下文'),
    '引用块直接显示原消息摘要');
  const quoteOrder = await sent.evaluate((node) => {
    const content = node.querySelector('.msg-content');
    if (!content) return null;
    const bubble = content.querySelector('.bubble');
    const quote = content.querySelector('.reply-reference');
    const children = Array.from(content.children);
    return {
      bubble: bubble ? children.indexOf(bubble) : -1,
      quote: quote ? children.indexOf(quote) : -1,
    };
  });
  check(quoteOrder !== null && quoteOrder.quote === quoteOrder.bubble + 1, '引用块紧接正文下方');
  const history = await rawTool<any>(d.me.token, 'network_history_list', { room_id: d.rooms.directWang.room_id });
  const reply = history.items.find((item: any) => item.preview === '引用不会丢草稿');
  check(reply?.reply_to === originalId, '发送引用保留真实reply_to');
  check(await page.locator('#composer-reply').isHidden() && await page.locator('#body').inputValue() === '', '成功发送清除本次文本和引用');
  await sent.locator('.reply-reference').click();
  await page.getByRole('dialog', { name: '查看上下文' }).getByText('明天下午三点见，记得带上资料。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭上下文' }).click();
  check(true, '点击引用可查看原消息上下文');
  const attachment = await uploadTextFile(d.me.token, fixture.base, '引用附件.txt', 'quote attachment');
  await original.getByRole('button', { name: '消息操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '引用', exact: true }).click();
  await page.locator('#body').fill('引用带附件\n' + attachment.publicUrl);
  await page.locator('#send').click();
  const sentWithFile = page.locator('#messages .msg').filter({ has: page.locator('.bubble', { hasText: '引用带附件' }) });
  await sentWithFile.locator('.msg-files').waitFor();
  const fileOrder = await sentWithFile.evaluate((node) => {
    const content = node.querySelector('.msg-content');
    if (!content) return null;
    const bubble = content.querySelector('.bubble');
    const files = content.querySelector('.msg-files');
    const quote = content.querySelector('.reply-reference');
    const children = Array.from(content.children);
    return {
      bubble: bubble ? children.indexOf(bubble) : -1,
      files: files ? children.indexOf(files) : -1,
      quote: quote ? children.indexOf(quote) : -1,
    };
  });
  check(fileOrder !== null && fileOrder.bubble < fileOrder.files && fileOrder.files < fileOrder.quote,
    '引用块位于附件下方、正文与附件在上');
  await sent.getByRole('button', { name: '消息操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '转发', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '转发消息' });
  await modal.getByRole('button', { name: '单聊 · 小李' }).click();
  await modal.getByRole('button', { name: '确认转发' }).click();
  await modal.waitFor({ state: 'hidden' });
  const forwarded = await rawTool<any>(d.me.token, 'network_history_list', { room_id: d.rooms.directLi.room_id });
  check(forwarded.items.filter((item: any) => item.preview.includes('【转发消息】') && item.preview.includes('引用不会丢草稿')).length === 1, '确认转发仅发送到选中会话一次');
  await sent.getByRole('button', { name: '消息操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '撤回', exact: true }).click();
  await page.locator('#confirm-dialog[open] [data-confirm-ok]').click();
  await page.locator('#messages .msg-recalled').waitFor();
  check(await page.locator('#messages').getByText('引用不会丢草稿', { exact: true }).count() === 0, '撤回后原气泡消失显示墓碑');

  const li = page.locator('#room-list a[data-room-id="' + d.rooms.directLi.room_id + '"]');
  await li.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '置顶聊天', exact: true }).click();
  check(await page.locator('#room-list a').first().getAttribute('data-room-id') === d.rooms.directLi.room_id, '置顶聊天排在首位');
  await li.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '消息免打扰', exact: true }).click();
  await page.reload();
  await page.locator('#messages .msg-recalled').waitFor();
  await page.locator('#room-list a[data-room-id="' + d.rooms.directLi.room_id + '"]').click({ button: 'right' });
  check(await page.getByRole('menuitem', { name: '取消置顶', exact: true }).isVisible() && await page.getByRole('menuitem', { name: '恢复消息提醒', exact: true }).isVisible(), '刷新保留当前身份置顶和免打扰');
  check(errors.length === 0, '浏览器无未捕获异常');
  console.log(JSON.stringify({ passed: results.length, results, errors }, null, 2));
} finally { await browser.close(); await fixture.stop(); }
