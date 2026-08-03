import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { devices, webkit } from '@playwright/test';

const userscript = await readFile(
  new URL('../popup-sentinel.user.js', import.meta.url),
  'utf8',
);

test('blocks a popup in a deeply nested rotating player without swallowing play', async () => {
  const browser = await webkit.launch();
  const context = await browser.newContext(devices['iPhone 13']);
  try {
    await context.addInitScript({ content: userscript });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      const documents = {
        'streamed.pk': '<iframe src="https://embed.st/embed/admin/test/1"></iframe>',
        'embed.st': '<iframe src="https://rotating-player.example/player"></iframe>',
        'rotating-player.example': '<iframe src="https://deep-ad-frame.example/player"></iframe>',
        'deep-ad-frame.example': `
          <button id="play" onclick="
            window.open('https://future-rotating-ad.example/landing');
            document.body.dataset.played = 'yes';
          ">Play</button>
        `,
        'future-rotating-ad.example': '<p>Popup escaped</p>',
      };
      await route.fulfill({
        contentType: 'text/html',
        body: documents[url.hostname] || '<p>Unknown test host</p>',
      });
    });

    const page = await context.newPage();
    await page.goto('https://streamed.pk/watch/deep-chain/admin/1');
    const deepFrame = page.frames().find(
      frame => new URL(frame.url()).hostname === 'deep-ad-frame.example',
    );
    assert.ok(deepFrame, 'deep rotating player frame did not load');

    await deepFrame.locator('#play').click();
    await page.waitForTimeout(250);

    assert.equal(
      await deepFrame.locator('body').getAttribute('data-played'),
      'yes',
      'popup protection swallowed the real play interaction',
    );
    assert.equal(context.pages().length, 1, 'deep player popup escaped');
  } finally {
    await context.close();
    await browser.close();
  }
});
