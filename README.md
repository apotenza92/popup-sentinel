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
`embedhd.st` chain.

## Development

```sh
npm install
npx playwright install webkit
npm test
```

The opt-in live mobile regression uses Playwright WebKit with an iPhone touch
profile. It first proves that the unprotected control opens a new top-level page,
then repeats the same real-player taps with Popup Sentinel enabled:

```sh
npm run test:live-mobile
```

The test fails as inconclusive if its control does not reproduce a popup. Set
`STREAMED_TEST_URL` to test another current `embed.st` player, or `HEADED=1` to
watch the WebKit run on the Mac. Screenshots, videos, and structured results are
written under `test-results/live-mobile/`.

MIT licensed.
