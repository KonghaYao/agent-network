import { chromium } from 'playwright';
import { createFixture } from './fixture';

const fixture = await createFixture(['mobile']);
const scenario = fixture.scenarios.mobile;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
await context.addInitScript((token) => localStorage.setItem('agent-network-token', token), scenario.me.token);
const page = await context.newPage();
page.setDefaultTimeout(9000);

const failures: string[] = [];
async function check(label: string, selectors: string[], touchSelectors: string[] = []) {
  const result = await page.evaluate(({ selectors, touchSelectors }) => {
    const width = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - width;
    const bounds = selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || !element.getClientRects().length) return { selector, missing: true };
      const rect = element.getBoundingClientRect();
      return { selector, x: Math.round(rect.left), right: Math.round(rect.right),
        width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    const small = touchSelectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => element.getClientRects().length && !element.hasAttribute('disabled'))
      .map((element) => ({ selector, text: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 16),
        width: Math.round(element.getBoundingClientRect().width), height: Math.round(element.getBoundingClientRect().height),
        fontSize: parseFloat(getComputedStyle(element).fontSize), tag: element.tagName }))
      .filter((target) => target.width < 44 || target.height < 44 ||
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tag) && target.fontSize < 16)));
    return { width, overflow, bounds, small };
  }, { selectors, touchSelectors });
  console.log(label, JSON.stringify(result));
  if (result.overflow > 1 || result.bounds.some((rect) => 'missing' in rect || rect.x < -1 || rect.right > result.width + 1) || result.small.length) {
    failures.push(`${label}: ${JSON.stringify(result)}`);
  }
}

async function checkHeight(label: string, container: string, controls: string[], content: string) {
  const result = await page.evaluate(({ container, controls, content }) => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element || !element.getClientRects().length) return null;
      const box = element.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) };
    };
    return { viewport: innerHeight, container: rect(container), controls: controls.map((selector) =>
      ({ selector, box: rect(selector) })), content: rect(content) };
  }, { container, controls, content });
  console.log(`${label} height`, JSON.stringify(result));
  if (!result.container || result.container.top < -1 || result.container.bottom > result.viewport + 1 ||
    result.controls.some(({ box }) => !box || box.top < -1 || box.bottom > result.viewport + 1) ||
    !result.content || result.content.height < 60) failures.push(`${label} height: ${JSON.stringify(result)}`);
}

try {
  for (const [width, height] of [[320, 400], [320, 568], [320, 844], [390, 600], [390, 844], [768, 844], [1280, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(fixture.base);
    await page.locator('#room-list a').first().waitFor();
    await check(`${width}×${height} list`, ['.sidebar', '.sidebar-head', '.sidebar-foot'],
      width < 760 ? ['#contact-requests', '#new-group', '#room-search', '.room-filter button'] : []);
    if (width < 760) {
      await page.locator('#new-group').click();
      await check(`${width}×${height} new group`, ['#group-modal .modal-card', '#group-search', '#group-cancel', '#group-create'],
        ['#group-cancel', '#group-create', '#group-search', '#group-contacts .contact-choice']);
      await checkHeight(`${width}×${height} new group`, '#group-modal .modal-card',
        ['#group-cancel', '#group-create'], '#group-contacts');
      await page.locator('#group-cancel').click();
      await page.locator('#contact-requests').click();
      await check(`${width}×${height} contacts`, ['#contact-modal .modal-card', '#contact-modal-close'],
        ['#contact-modal-close', '#contact-search-input', '#contact-search-submit', '#contact-link-create', '#contact-policy-select']);
      await checkHeight(`${width}×${height} contacts`, '#contact-modal .modal-card',
        ['#contact-modal-close'], '.contact-panels');
      if (process.env.UX_SCREENSHOTS && width === 320 && height === 400) {
        await page.screenshot({ path: '/tmp/agent-network-contact-short.png' });
      }
      const contactFooter = await page.locator('#contact-modal-close').boundingBox();
      if (!contactFooter || contactFooter.y + contactFooter.height < height - 24) {
        failures.push(`${width}×${height} contacts: footer floats above the bottom`);
      }
      await page.locator('#contact-modal-close').click();
      await page.locator('#new-agent').click();
      await checkHeight(`${width}×${height} new agent`, '#new-agent-modal .modal-card',
        ['#new-agent-close', '#new-agent-create'], '#new-agent-form');
      await page.locator('#new-agent-close').click();
      await page.locator('#device-handoff').click();
      await page.locator('#pairing-qr-wrap').waitFor({ state: 'visible' });
      await checkHeight(`${width}×${height} pairing`, '#handoff-modal .modal-card',
        ['#handoff-close'], '.handoff-columns');
      if (process.env.UX_SCREENSHOTS && width === 320 && height === 400) {
        await page.screenshot({ path: '/tmp/agent-network-pairing-short.png' });
      }
      if (width === 390 && height === 844) {
        await page.setViewportSize({ width, height: 400 });
        await checkHeight('390×400 pairing after resize', '#handoff-modal .modal-card',
          ['#handoff-close'], '.handoff-columns');
        await page.locator('.handoff-columns').evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await checkHeight('390×400 pairing after scroll', '#handoff-modal .modal-card',
          ['#handoff-close'], '.handoff-columns');
        await page.setViewportSize({ width, height });
      }
      await page.locator('#handoff-close').click();
    }
    await page.getByRole('tab', { name: '群聊', exact: true }).click();
    await page.locator(`#room-list a[href="/c/${scenario.rooms.owned.room_id}"]`).click();
    await page.locator('#title').getByText('周末活动讨论群').waitFor();
    await check(`${width}×${height} room`, ['.chat-head', '#title', '#files-toggle', '.composer', '#send'],
      width < 760 ? ['#back', '#files-toggle', '#monitor-toggle', '#send', '#attach-file', '#add-members', '#room-announcement-edit'] : []);
    const titleClipped = await page.locator('#title').evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    if (titleClipped) failures.push(`${width}×${height} room: title is clipped`);
    if (width < 760) {
      await page.locator('#add-members').click();
      await check(`${width}×${height} members`, ['#members-modal .modal-card', '.members-columns', '#members-close', '#members-add'],
        ['#members-close', '#members-add', '#members-cancel', '.member-menu-toggle', '#members-current-search', '#members-search']);
      await checkHeight(`${width}×${height} members`, '#members-modal .modal-card',
        ['#members-close', '#members-add', '#members-cancel'], '.members-scroll');
      if (width === 390 && height === 844) {
        await page.setViewportSize({ width, height: 400 });
        await checkHeight('390×400 members after resize', '#members-modal .modal-card',
          ['#members-close', '#members-add', '#members-cancel'], '.members-scroll');
        await page.setViewportSize({ width, height });
      }
      const columns = await page.locator('.members-columns .members-column').evaluateAll((elements) =>
        elements.map((element) => Math.round(element.getBoundingClientRect().left)));
      if (columns[0] !== columns[1]) failures.push(`${width}×${height} members: columns are side by side`);
      const footer = await page.locator('#members-add').boundingBox();
      if (!footer || footer.y + footer.height > height + 1) failures.push(`${width}×${height} members: action footer is offscreen`);
      await page.locator('#members-close').click();
      await page.locator('#room-announcement-edit').click();
      await checkHeight(`${width}×${height} announcement`, '#announcement-modal .modal-card',
        ['#announcement-close', '#announcement-save'], '#announcement-input');
      await page.locator('#announcement-close').click();
      await page.locator('#files-toggle').click();
      await check(`${width}×${height} files`, ['#files-pane', '.files-head', '#files-close'],
        ['#files-close', '#files-upload', '#files-drop']);
      await checkHeight(`${width}×${height} files`, '#files-pane',
        ['#files-close', '#files-upload'], '#files-list');
      await page.locator('#file-preview').evaluate((element: HTMLDialogElement) => element.showModal());
      await checkHeight(`${width}×${height} preview`, '#file-preview .file-preview-card',
        ['#file-preview-close'], '#file-preview-body');
      await check(`${width}×${height} preview controls`, ['#file-preview .file-preview-card'],
        ['#file-preview-close']);
      await page.locator('#file-preview').evaluate((element: HTMLDialogElement) => element.close());
      await page.locator('#files-close').click();
      await page.locator('#monitor-toggle').click();
      await check(`${width}×${height} monitor`, ['#monitor-pane', '.monitor-toolbar', '#monitor-url', '#monitor-close'],
        ['#monitor-url', '.monitor-actions .monitor-icon:not([aria-disabled="true"])']);
      await checkHeight(`${width}×${height} monitor`, '#monitor-pane',
        ['#monitor-url', '#monitor-close'], '#monitor-frame-wrap');
      await page.locator('#monitor-close').click();
      await page.locator('#task-trace-drawer').evaluate((element: HTMLDialogElement) => element.showModal());
      await checkHeight(`${width}×${height} trace`, '.task-trace-card',
        ['#task-trace-close'], '#task-trace-items');
      await page.locator('#task-trace-drawer').evaluate((element: HTMLDialogElement) => element.close());
    } else {
      for (const [toggle, pane, close] of [
        ['#files-toggle', '#files-pane', '#files-close'],
        ['#monitor-toggle', '#monitor-pane', '#monitor-close'],
      ] as const) {
        if (await page.locator(pane).isVisible()) await page.locator(close).click();
        await page.locator(toggle).click();
        await check(`${width}×${height} ${pane}`, [pane, '.chat-head', '#title']);
        const panel = await page.locator(pane).boundingBox();
        if (!panel || (width < 1200 && panel.x + panel.width < width - 1) ||
          (width >= 1200 && panel.x < 300)) failures.push(`${width}×${height} ${pane}: incorrect panel placement`);
        await page.locator(close).click();
      }
    }
  }
} finally {
  await context.close();
  await browser.close();
  await fixture.stop();
}

if (failures.length) throw new Error(`Responsive layout failures:\n${failures.join('\n')}`);
