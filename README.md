# Popup Sentinel

A lightweight userscript that blocks known popup generators without disabling legitimate new windows.

Popup Sentinel uses narrowly scoped site profiles, making it easy to add new protections without applying risky global overrides.

## Install

Add this URL to your userscript manager:

```text
https://raw.githubusercontent.com/apotenza92/popup-sentinel/main/popup-sentinel.user.js
```

The downstream video host can rotate, so the Safari userscript extension needs
access to **All Websites**. Popup Sentinel still activates only on a supported
Streamed page or in a player frame reached through the trusted `embed.st` /
`embedhd.st` chain. Trusted provenance is carried through deeper rotating
cross-origin player frames without naming advertising domains.

## Development

```sh
npm install
npx playwright install webkit
npm test
```

The opt-in live mobile regression uses Playwright WebKit with an iPhone touch
profile. It must start from a complete Streamed `/watch/` page, prove that the
unprotected control opens a new top-level page, then prove that the protected
page reaches real playback without opening any new page:

```sh
STREAMED_TEST_URL='https://streamed.pk/watch/…' npm run test:live-mobile
```

Direct player or iframe URLs are rejected because they do not prove the whole
watch-page flow. The test also fails if its control does not reproduce a popup,
the stream does not remain in playback, decoded video pixels do not change
across three screenshots, or an anti-bot check prevents the player from
loading. Set `HEADED=1` to watch the WebKit run on the Mac. Screenshots, videos,
per-pixel comparisons, frame traces, and structured results are written under
`test-results/live-mobile/`.
When a manual anti-bot check is required, pass its temporary Playwright storage
state with `STREAMED_TEST_STORAGE_STATE`.

MIT licensed.
