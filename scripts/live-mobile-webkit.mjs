import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devices, webkit } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userscriptPath = resolve(repoRoot, 'popup-sentinel.user.js');
const userscript = await readFile(userscriptPath, 'utf8');
const targetURL = process.env.STREAMED_TEST_URL;
const artifactRoot = resolve(
  repoRoot,
  process.env.STREAMED_TEST_ARTIFACTS || 'test-results/live-mobile',
);
const storageStatePath = process.env.STREAMED_TEST_STORAGE_STATE
  ? resolve(process.env.STREAMED_TEST_STORAGE_STATE)
  : null;
const tapCount = Number.parseInt(process.env.STREAMED_TEST_TAPS || '3', 10);
const playerTimeout = Number.parseInt(
  process.env.STREAMED_TEST_PLAYER_TIMEOUT || '45000',
  10,
);
const playbackTimeout = Number.parseInt(
  process.env.STREAMED_TEST_PLAYBACK_TIMEOUT || '15000',
  10,
);
const interactionProbe = `(() => {
  const probe = { interactions: [] };
  Object.defineProperty(globalThis, '__POPUP_SENTINEL_LIVE_PROBE__', {
    configurable: false,
    value: probe,
  });
  for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'click']) {
    addEventListener(type, event => {
      probe.interactions.push({
        type,
        trusted: event.isTrusted,
        target: event.target instanceof Element ? event.target.tagName : '',
      });
    }, true);
  }
})();`;

if (!Number.isInteger(tapCount) || tapCount < 1) {
  throw new Error('STREAMED_TEST_TAPS must be a positive integer');
}

if (!targetURL) {
  throw new Error(
    'STREAMED_TEST_URL is required and must be a full Streamed /watch/ URL.',
  );
}

const parsedTargetURL = new URL(targetURL);
const supportedWatchHosts = new Set(['streamed.pk', 'streamed.st', 'streami.su']);
if (
  !supportedWatchHosts.has(parsedTargetURL.hostname) ||
  !parsedTargetURL.pathname.startsWith('/watch/')
) {
  throw new Error(
    'STREAMED_TEST_URL must start at a supported Streamed /watch/ page; ' +
    'direct player or iframe URLs are diagnostic-only.',
  );
}

const browser = await webkit.launch({ headless: process.env.HEADED !== '1' });

const waitForVideoFrame = async page => {
  const deadline = Date.now() + playerTimeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.locator('video').count().catch(() => 0)) return frame;
    }
    await page.waitForTimeout(500);
  }
  return null;
};

const mediaState = locator =>
  locator.evaluate(video => ({
    paused: video.paused,
    currentTime: video.currentTime,
    readyState: video.readyState,
  }));

const runCase = async ({ name, enabled }) => {
  const outputDirectory = resolve(artifactRoot, name);
  await mkdir(outputDirectory, { recursive: true });

  const context = await browser.newContext({
    ...devices['iPhone 13'],
    locale: 'en-AU',
    timezoneId: 'Australia/Melbourne',
    recordVideo: { dir: outputDirectory },
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  await context.addInitScript({ content: interactionProbe });
  if (enabled) await context.addInitScript({ content: userscript });

  const popupEvents = [];
  const rootNavigations = [];
  let rootPage;
  context.on('page', page => {
    if (rootPage && page !== rootPage) {
      const popup = { initialURL: page.url(), navigations: [] };
      popupEvents.push(popup);
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame()) popup.navigations.push(frame.url());
      });
    }
  });

  rootPage = await context.newPage();
  rootPage.on('framenavigated', frame => {
    if (frame === rootPage.mainFrame()) rootNavigations.push(frame.url());
  });
  await rootPage.goto(targetURL, { waitUntil: 'commit', timeout: 30000 });

  const playerFrame = await waitForVideoFrame(rootPage);
  if (!playerFrame) {
    const frameURLs = rootPage.frames().map(frame => frame.url());
    await rootPage.screenshot({
      path: resolve(outputDirectory, 'player-not-found.png'),
      fullPage: true,
    });
    await context.close();
    throw new Error(
      `${name}: inconclusive because no video frame appeared within ${playerTimeout}ms\n` +
      frameURLs.join('\n'),
    );
  }

  const video = playerFrame.locator('video').first();
  const before = await mediaState(video);
  const taps = [];
  for (let index = 1; index <= tapCount; index += 1) {
    const interactionCountBefore = await playerFrame.evaluate(
      () => globalThis.__POPUP_SENTINEL_LIVE_PROBE__.interactions.length,
    );
    await video.tap({ force: true, timeout: 10000 });
    await rootPage.waitForTimeout(2000);
    const interactions = await playerFrame.evaluate(
      count => globalThis.__POPUP_SENTINEL_LIVE_PROBE__.interactions.slice(count),
      interactionCountBefore,
    );
    const media = await mediaState(video).catch(() => null);
    taps.push({
      index,
      media,
      popupCount: popupEvents.length,
      interactions,
    });
    if (media && !media.paused) break;
  }

  const playbackDeadline = Date.now() + playbackTimeout;
  let after = await mediaState(video);
  while (
    Date.now() < playbackDeadline &&
    (
      after.paused ||
      after.readyState < 2 ||
      after.currentTime <= before.currentTime
    )
  ) {
    await rootPage.waitForTimeout(500);
    after = await mediaState(video);
  }

  await rootPage.screenshot({
    path: resolve(outputDirectory, 'after-taps.png'),
    fullPage: true,
  });
  const result = {
    name,
    enabled,
    targetURL,
    finalRootURL: rootPage.url(),
    rootNavigations,
    playerURL: playerFrame.url(),
    before,
    after,
    taps,
    popupEvents,
  };
  await writeFile(
    resolve(outputDirectory, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await context.close();
  return result;
};

try {
  console.log(`Live mobile target: ${targetURL}`);
  console.log('Running control without Popup Sentinel...');
  const control = await runCase({ name: 'control', enabled: false });
  console.log(`Control popups after ${tapCount} taps: ${control.popupEvents.length}`);
  assert.ok(
    control.popupEvents.length > 0,
    'Inconclusive: the control did not reproduce a popup, so the treatment cannot prove a fix.',
  );

  console.log('Running treatment with Popup Sentinel...');
  const treatment = await runCase({ name: 'popup-sentinel', enabled: true });
  console.log(`Treatment popups after ${tapCount} taps: ${treatment.popupEvents.length}`);
  assert.equal(
    treatment.popupEvents.length,
    0,
    `Popup Sentinel allowed ${treatment.popupEvents.length} popup(s).`,
  );
  assert.equal(
    treatment.finalRootURL,
    parsedTargetURL.href,
    `The original watch tab was redirected to ${treatment.finalRootURL}.`,
  );
  assert.ok(
    treatment.rootNavigations.every(url => url === parsedTargetURL.href),
    `The original watch tab left the requested URL: ${treatment.rootNavigations.join(', ')}`,
  );
  assert.ok(
    treatment.taps.some(tap =>
      tap.interactions.some(interaction =>
        interaction.trusted &&
        (interaction.type === 'pointerdown' || interaction.type === 'touchstart')
      )
    ),
    'No popup opened, but no tap reached the real player frame.',
  );
  assert.ok(
    !treatment.after.paused &&
    treatment.after.readyState >= 2 &&
    treatment.after.currentTime > treatment.before.currentTime,
    'No popup opened, but the stream never entered real playback.',
  );

  console.log(
    'PASS: the whole watch page reached playback; the control reproduced ' +
    'popups and the treatment blocked all of them.',
  );
  console.log(`Artifacts: ${artifactRoot}`);
} finally {
  await browser.close();
}
