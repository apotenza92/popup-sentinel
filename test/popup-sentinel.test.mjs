import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../popup-sentinel.user.js', import.meta.url), 'utf8');
const api = {};
vm.runInNewContext(source, { __POPUP_SENTINEL_TEST__: api, URL });

const streamed = api.profileForHost('embed.st');

test('selects the streamed profile for supported hosts', () => {
  assert.equal(streamed.id, 'streamed');
  assert.equal(api.profileForHost('streamed.pk').id, 'streamed');
  assert.equal(api.profileForHost('embedhd.st').id, 'streamed');
  assert.equal(api.profileForHost('unknown.example'), undefined);
});

test('blocks the verified embed.st advertising frame', () => {
  assert.equal(
    api.isBlockedFrameURL(streamed, '/ad.html', 'https://embed.st/player/1', 'embed.st'),
    true,
  );
  assert.equal(
    api.isBlockedFrameURL(streamed, '/ad.html?rotation=2', 'https://embed.st/player/1', 'embed.st'),
    true,
  );
  assert.equal(
    api.isBlockedFrameURL(
      streamed,
      '/ads.html',
      'https://embedhd.st/source/streamed.php',
      'embedhd.st',
    ),
    true,
  );
  assert.equal(
    streamed.blockedHTML.some(pattern =>
      pattern.test('<iframe style="visibility:hidden" src="/ads.html"></iframe>'),
    ),
    true,
  );
});

test('preserves normal player frames and pages', () => {
  assert.equal(
    api.isBlockedFrameURL(streamed, '/embed/admin/game/1', 'https://embed.st/', 'embed.st'),
    false,
  );
  assert.equal(
    api.isBlockedFrameURL(streamed, 'https://cdn.jsdelivr.net/player.html', 'https://embed.st/', 'embed.st'),
    false,
  );
});

test('blocks the observed downstream advertising host', () => {
  assert.equal(
    api.isBlockedFrameURL(
      streamed,
      'https://ndcertainlywhen.com/?tid=1229910',
      'https://embed.st/ad.html',
      'embed.st',
    ),
    true,
  );
  assert.equal(
    api.isBlockedPopupURL(streamed, 'https://ndcertainlywhen.com/click', 'https://embed.st/'),
    true,
  );
  assert.equal(
    api.isBlockedFrameURL(
      streamed,
      'https://onandasmilee.com/?cu3vf=1252473',
      'https://embedhd.st/ads.html',
      'embedhd.st',
    ),
    true,
  );
  assert.equal(
    api.isBlockedPopupURL(
      streamed,
      'https://www.togglevpn.org/?campaign_name=POP%20-%20iOS%20-%20CPA&cw_p1=10521572',
      'https://embedhd.st/',
    ),
    true,
  );
});

test('blocks blank popups from the verified generator before delayed ad navigation', () => {
  for (const host of ['streamed.pk', 'streamed.st', 'streami.su', 'embed.st']) {
    const base = `https://${host}/watch/fixture`;

    // aclib opens an initially blank window, then navigates it to the ad later.
    assert.equal(api.isBlockedPopupOpen(streamed, undefined, base, host, true), true);
    assert.equal(api.isBlockedPopupOpen(streamed, '', base, host, true), true);
    assert.equal(api.isBlockedPopupOpen(streamed, 'about:blank', base, host, true), true);
    assert.equal(api.isBlockedPopupOpen(streamed, 'about:blank#opened', base, host, true), true);
  }
});

test('recognizes only the verified aclib popup activation marker', () => {
  assert.equal(
    api.hasVerifiedPopupGenerator(streamed, ["aclib.runPop({zoneId: '10521566'});"]),
    true,
  );
  assert.equal(api.hasVerifiedPopupGenerator(streamed, ['aclib . runPop ({ zoneId: 9742758 })']), true);
  assert.equal(api.hasVerifiedPopupGenerator(streamed, ['aclib.runInterstitial({ zoneId: 1 })']), false);
  assert.equal(api.hasVerifiedPopupGenerator(streamed, ['const zoneId = 10521566']), false);
});

test('recognizes the current rotating-host popup loader URL shape', () => {
  assert.equal(
    api.isVerifiedPopupLoaderURL(
      streamed,
      'https://therocketlanguages.com/18/88/42/188842a03a6c7d8cc1c6c6db841702b3.js?mg=1',
      'https://streamed.pk/',
    ),
    true,
  );
  assert.equal(
    api.isVerifiedPopupLoaderURL(
      streamed,
      'https://rotated-ad-host.example/18/88/42/188842a03a6c7d8cc1c6c6db841702b3.js?foo=1&mg=1',
      'https://streamed.pk/',
    ),
    true,
  );
  assert.equal(
    api.isVerifiedPopupLoaderURL(
      streamed,
      'https://cdn.example/app/188842a03a6c7d8cc1c6c6db841702b3.js',
      'https://streamed.pk/',
    ),
    false,
  );
  assert.equal(
    api.isVerifiedPopupLoaderURL(
      streamed,
      'https://acscdn.com/script/aclib.js',
      'https://embedhd.st/',
    ),
    true,
  );
});

test('blocks interaction listeners registered by the verified popup generator', () => {
  const loader =
    'https://therocketlanguages.com/18/88/42/188842a03a6c7d8cc1c6c6db841702b3.js?mg=1';

  for (const type of ['click', 'mousedown', 'touchstart', 'touchend', 'pointerdown']) {
    assert.equal(
      api.shouldBlockPopupListener(streamed, type, loader, '', 'https://streamed.pk/'),
      true,
    );
  }
  assert.equal(
    api.shouldBlockPopupListener(
      streamed,
      'scroll',
      loader,
      '',
      'https://streamed.pk/',
    ),
    false,
  );
  assert.equal(
    api.shouldBlockPopupListener(
      streamed,
      'click',
      '',
      "aclib.runPop({zoneId: '11323166'});",
      'https://streamed.pk/',
    ),
    true,
  );
  assert.equal(
    api.shouldBlockPopupListener(
      streamed,
      'click',
      'https://streamed.pk/app.js',
      '',
      'https://streamed.pk/',
    ),
    false,
  );
});

test('recognizes the verified nearly transparent full-screen popup overlay', () => {
  assert.equal(api.isPopupOverlayStyle('fixed', '2147483650', '.01'), true);
  assert.equal(api.isPopupOverlayStyle('fixed', '2147483639', '.01'), false);
  assert.equal(api.isPopupOverlayStyle('absolute', '2147483650', '.01'), false);
  assert.equal(api.isPopupOverlayStyle('fixed', '2147483650', '1'), false);
});

test('preserves blank popups when the verified generator is absent', () => {
  assert.equal(
    api.isBlockedPopupOpen(streamed, 'about:blank', 'https://embed.st/player/1', 'embed.st', false),
    false,
  );
  assert.equal(
    api.isBlockedPopupOpen(streamed, '', 'https://streamed.pk/watch/1', 'streamed.pk', false),
    false,
  );
});

test('does not apply the generator rule on unsupported hosts or unrelated direct URLs', () => {
  assert.equal(
    api.isBlockedPopupOpen(streamed, 'about:blank', 'https://example.com/', 'example.com', true),
    false,
  );
  assert.equal(
    api.isBlockedPopupOpen(
      streamed,
      'https://example.com/account/help',
      'https://embed.st/player/1',
      'embed.st',
      true,
    ),
    false,
  );
});

test('does not blanket-block blank or unrelated popups', () => {
  assert.equal(api.isBlockedPopupURL(streamed, 'about:blank', 'https://embed.st/'), false);
  assert.equal(api.isBlockedPopupURL(streamed, 'https://example.com/', 'https://embed.st/'), false);
});
