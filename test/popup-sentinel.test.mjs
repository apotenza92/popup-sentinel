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
});

test('does not blanket-block blank or unrelated popups', () => {
  assert.equal(api.isBlockedPopupURL(streamed, 'about:blank', 'https://embed.st/'), false);
  assert.equal(api.isBlockedPopupURL(streamed, 'https://example.com/', 'https://embed.st/'), false);
});
