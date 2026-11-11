import { chromium } from 'playwright';
import { createFixture } from './fixture';

const fixture = await createFixture(['mobile']);
const scenario = fixture.scenarios.mobile;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 768 } });
await context.addInitScript((token) => localStorage.setItem('agent-network-token', token), scenario.me.token);
const page = await context.newPage();
page.setDefaultTimeout(9000);
const failures: string[] = [];

async function inspect(label: string, selectors: string[], minContent?: string) {
  const result = await page.evaluate(({ selectors, minContent }) => {
    const boxes = selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || !element.getClientRects().length) return { selector, missing: true };
      const box = element.getBoundingClientRect();
      return { selector, x: Math.round(box.x), y: Math.round(box.y),
        right: Math.round(box.right), bottom: Math.round(box.bottom),
        width: Math.round(box.width), height: Math.round(box.height) };
    });
    const content = minContent ? document.querySelector<HTMLElement>(minContent) : null;
    return { viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth - innerWidth,
      boxes, contentHeight: content ? Math.round(content.getBoundingClientRect().height) : null };
  }, { selectors, minContent });
  console.log(label, JSON.stringify(result));
  if (result.overflow > 1 || result.boxes.some((box) => 'missing' in box ||
    box.x < -1 || box.y < -1 || box.right > result.viewport.width + 1 ||
    box.bottom > result.viewport.height + 1) || (minContent && (result.contentHeight ?? 0) < 48)) {
    failures.push(`${label}: ${JSON.stringify(result)}`);
  }
  return result;
}

try {
  for (const [width, height] of [[1024, 600], [1200, 600], [1280, 400], [1440, 768], [1920, 1080]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(fixture.base);
    await page.locator('#room-list a').first().waitFor();
    await inspect(`${width}×${height} list`, ['.sidebar', '.sidebar-head', '.sidebar-list', '.sidebar-foot'], '.sidebar-list');
    await page.locator('#new-group').click();
    await inspect(`${width}×${height} new group`, ['#group-modal .modal-card', '#group-cancel', '#group-create'], '#group-contacts');
    await page.locator('#group-cancel').click();
    await page.locator('#contact-requests').click();
    await inspect(`${width}×${height} contacts`, ['#contact-modal .modal-card', '#contact-modal-close'], '.contact-columns');
    await page.locator('#contact-modal-close').click();
    await page.locator('#device-handoff').click();
    await page.locator('#pairing-qr-wrap').waitFor({ state: 'visible' });
    await inspect(`${width}×${height} pairing`, ['#handoff-modal .modal-card', '#handoff-close'], '.handoff-columns');
    if (width === 1280 && height === 400) {
      const columns = await page.locator('.handoff-columns').evaluate((element) =>
        ({ visible: element.clientHeight, content: element.scrollHeight }));
      if (columns.content <= columns.visible) failures.push('1280×400 pairing: content did not scroll independently');
      await page.locator('.handoff-columns').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await inspect('1280×400 pairing after scroll', ['#handoff-modal .modal-card', '#handoff-close'], '.handoff-columns');
    }
    if (width === 1920) {
      await page.setViewportSize({ width, height: 400 });
      await inspect('1920×400 pairing after resize', ['#handoff-modal .modal-card', '#handoff-close'], '.handoff-columns');
      await page.setViewportSize({ width, height });
    }
    await page.locator('#handoff-close').click();
    await page.getByRole('tab', { name: '群聊', exact: true }).click();
    await page.locator(`#room-list a[href="/c/${scenario.rooms.owned.room_id}"]`).click();
    await page.locator('#title').getByText('周末活动讨论群').waitFor();
    await inspect(`${width}×${height} room`, ['.chat-pane:not(.empty-pane)', '.chat-head', '#title', '#files-toggle', '.messages', '.composer'], '.messages');
    await page.locator('#add-members').click();
    await inspect(`${width}×${height} members`, ['#members-modal .modal-card', '#members-close', '#members-add'], '.members-scroll');
    await page.locator('#members-close').click();
    if (await page.locator('#files-pane').isVisible()) await page.locator('#files-close').click();
    await page.locator('#files-toggle').click();
    await inspect(`${width}×${height} files`, ['#files-pane', '#files-close', '.files-list', '.chat-head', '#title'], '.files-list');
    const title = await page.locator('#title').evaluate((element) =>
      ({ available: element.clientWidth, needed: element.scrollWidth }));
    if (title.needed > title.available + 1) failures.push(`${width}×${height} files: group title clipped ${JSON.stringify(title)}`);
    if (width === 1280 && title.available < 200) failures.push(`${width}×${height} files: title width ${title.available}`);
    if (process.env.UX_SCREENSHOTS && width === 1280 && height === 400) {
      await page.screenshot({ path: '/tmp/agent-network-desktop-files.png' });
    }
    await page.locator('#files-close').click();
    await page.locator('#monitor-toggle').click();
    await inspect(`${width}×${height} monitor`, ['#monitor-pane', '#monitor-url', '#monitor-close', '.monitor-frame-wrap'], '.monitor-frame-wrap');
    const urlWidth = await page.locator('#monitor-url').evaluate((element) => element.getBoundingClientRect().width);
    if (urlWidth < 130) failures.push(`${width}×${height} monitor: URL input width ${urlWidth}`);
    await page.locator('#monitor-close').click();
  }
} finally {
  await context.close();
  await browser.close();
  await fixture.stop();
}

if (failures.length) throw new Error(`Desktop layout failures:\n${failures.join('\n')}`);
