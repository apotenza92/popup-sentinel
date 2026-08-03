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
const controlTapCount = Number.parseInt(
  process.env.STREAMED_TEST_CONTROL_TAPS || process.env.STREAMED_TEST_TAPS || '5',
  10,
);
const treatmentTapCount = Number.parseInt(
  process.env.STREAMED_TEST_TREATMENT_TAPS || '1',
  10,
);
const treatmentSettleTimeout = Number.parseInt(
  process.env.STREAMED_TEST_TREATMENT_SETTLE || '5000',
  10,
);
const playerTimeout = Number.parseInt(
  process.env.STREAMED_TEST_PLAYER_TIMEOUT || '45000',
  10,
);
const playbackTimeout = Number.parseInt(
  process.env.STREAMED_TEST_PLAYBACK_TIMEOUT || '15000',
  10,
);
const interactionProbe = `(() => {
  const probe = { interactions: [], openCalls: [] };
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
  const originalOpen = window.open;
  window.open = new Proxy(originalOpen, {
    apply(target, thisArg, args) {
      probe.openCalls.push({
        url: String(args[0] || 'about:blank'),
        frameURL: location.href,
        referrer: document.referrer,
      });
      return Reflect.apply(target, thisArg, args);
    },
  });
})();`;

if (!Number.isInteger(controlTapCount) || controlTapCount < 1) {
  throw new Error('STREAMED_TEST_CONTROL_TAPS must be a positive integer');
}

if (treatmentTapCount !== 1) {
  throw new Error('STREAMED_TEST_TREATMENT_TAPS must remain exactly 1');
}

if (!Number.isInteger(treatmentSettleTimeout) || treatmentSettleTimeout < 0) {
  throw new Error('STREAMED_TEST_TREATMENT_SETTLE must be a non-negative integer');
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

const compareScreenshotPixels = (frame, before, after) =>
  frame.evaluate(async ({ beforeBase64, afterBase64 }) => {
    const decode = async base64 => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    };

    const [beforeImage, afterImage] = await Promise.all([
      decode(beforeBase64),
      decode(afterBase64),
    ]);
    if (
      beforeImage.width !== afterImage.width ||
      beforeImage.height !== afterImage.height
    ) {
      throw new Error('Visual proof frames have different dimensions.');
    }

    const pixelsFor = image => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const beforePixels = pixelsFor(beforeImage);
    const afterPixels = pixelsFor(afterImage);
    let changedPixels = 0;
    let absoluteChannelDelta = 0;
    for (let offset = 0; offset < beforePixels.length; offset += 4) {
      const red = Math.abs(beforePixels[offset] - afterPixels[offset]);
      const green = Math.abs(beforePixels[offset + 1] - afterPixels[offset + 1]);
      const blue = Math.abs(beforePixels[offset + 2] - afterPixels[offset + 2]);
      const alpha = Math.abs(beforePixels[offset + 3] - afterPixels[offset + 3]);
      absoluteChannelDelta += red + green + blue + alpha;
      if (Math.max(red, green, blue, alpha) >= 8) changedPixels += 1;
    }

    const totalPixels = beforeImage.width * beforeImage.height;
    return {
      width: beforeImage.width,
      height: beforeImage.height,
      totalPixels,
      changedPixels,
      changedRatio: changedPixels / totalPixels,
      meanAbsoluteChannelDelta: absoluteChannelDelta / (totalPixels * 4),
    };
  }, {
    beforeBase64: before.toString('base64'),
    afterBase64: after.toString('base64'),
  });

const captureVisualProof = async (frame, video, outputDirectory) => {
  const captures = [];
  for (let index = 1; index <= 3; index += 1) {
    const buffer = await video.screenshot({
      path: resolve(outputDirectory, `playback-frame-${index}.png`),
    });
    captures.push({
      index,
      media: await mediaState(video),
      buffer,
    });
    if (index < 3) await frame.page().waitForTimeout(1000);
  }

  const comparisons = [];
  for (let index = 1; index < captures.length; index += 1) {
    comparisons.push({
      from: captures[index - 1].index,
      to: captures[index].index,
      ...await compareScreenshotPixels(
        frame,
        captures[index - 1].buffer,
        captures[index].buffer,
      ),
    });
  }

  return {
    captures: captures.map(({ index, media }) => ({ index, media })),
    comparisons,
    mediaTimeDelta:
      captures[captures.length - 1].media.currentTime - captures[0].media.currentTime,
    continuouslyPlaying: captures.every(
      capture => !capture.media.paused && capture.media.readyState >= 2,
    ),
    maximumChangedRatio: Math.max(...comparisons.map(item => item.changedRatio)),
  };
};

const runCase = async ({ name, enabled, tapLimit, settleBeforeTap = 0 }) => {
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
  if (settleBeforeTap > 0) await rootPage.waitForTimeout(settleBeforeTap);
  const taps = [];
  for (let index = 1; index <= tapLimit; index += 1) {
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

  const visualProof = await captureVisualProof(
    playerFrame,
    video,
    outputDirectory,
  );

  await rootPage.screenshot({
    path: resolve(outputDirectory, 'after-taps.png'),
    fullPage: true,
  });
  const frameEvidence = [];
  for (const frame of rootPage.frames()) {
    frameEvidence.push(await frame.evaluate(() => ({
      frameURL: location.href,
      referrer: document.referrer,
      interactions: globalThis.__POPUP_SENTINEL_LIVE_PROBE__?.interactions || [],
      openCalls: globalThis.__POPUP_SENTINEL_LIVE_PROBE__?.openCalls || [],
    })).catch(error => ({
      frameURL: frame.url(),
      error: String(error),
    })));
  }
  const result = {
    name,
    enabled,
    targetURL,
    finalRootURL: rootPage.url(),
    rootNavigations,
    playerURL: playerFrame.url(),
    before,
    after,
    visualProof,
    taps,
    popupEvents,
    frameEvidence,
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
  const control = await runCase({
    name: 'control',
    enabled: false,
    tapLimit: controlTapCount,
  });
  console.log(
    `Control popups after ${control.taps.length} tap(s): ${control.popupEvents.length}`,
  );
  assert.ok(
    control.popupEvents.length > 0,
    'Inconclusive: the control did not reproduce a popup, so the treatment cannot prove a fix.',
  );
  assert.ok(
    !control.after.paused &&
    control.after.readyState >= 2 &&
    control.after.currentTime > control.before.currentTime,
    'Inconclusive: the unprotected control reproduced popups but did not reach playback.',
  );
  assert.ok(
    control.visualProof.maximumChangedRatio >= 0.001,
    'Inconclusive: the control media state advanced but its rendered video pixels stayed static.',
  );
  assert.ok(
    control.visualProof.continuouslyPlaying &&
    control.visualProof.mediaTimeDelta >= 0.5,
    'Inconclusive: the control video stalled during the pixel-proof sequence.',
  );

  console.log('Running one-click treatment with Popup Sentinel...');
  const treatment = await runCase({
    name: 'popup-sentinel',
    enabled: true,
    tapLimit: treatmentTapCount,
    settleBeforeTap: treatmentSettleTimeout,
  });
  console.log(
    `Treatment popups after exactly ${treatment.taps.length} tap: ` +
    treatment.popupEvents.length,
  );
  assert.equal(
    treatment.taps.length,
    1,
    'The protected player did not reach playback from exactly one tap.',
  );
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
  assert.ok(
    treatment.visualProof.maximumChangedRatio >= 0.001,
    'No popup opened and media time advanced, but rendered video pixels stayed static.',
  );
  assert.ok(
    treatment.visualProof.continuouslyPlaying &&
    treatment.visualProof.mediaTimeDelta >= 0.5,
    'No popup opened, but video stalled during the pixel-proof sequence.',
  );

  console.log(
    'PASS: the whole watch page reached playback with changing video pixels; ' +
    'the control reproduced popups and the treatment blocked all of them.',
  );
  console.log(`Artifacts: ${artifactRoot}`);
} finally {
  await browser.close();
}
