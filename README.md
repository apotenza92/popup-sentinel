# Popup Sentinel

Popup Sentinel is a policy-driven userscript that blocks verified popup generators without disabling every `window.open()` call on a site.

The first profile covers the `streamed.pk` family and its `embed.st` player. It targets the mechanisms observed in July 2026:

- the hidden `embed.st/ad.html` iframe;
- frames and direct popups to the observed downstream advertising host;
- inline advertising bundles containing `adserverDomain`;
- DOM insertion methods used to recreate those elements.

Normal player frames, unrelated links, `about:blank`, and ordinary new-window behavior remain available unless a future site profile explicitly classifies them as advertising.

## Install

Install the userscript from:

```text
https://raw.githubusercontent.com/apotenza92/popup-sentinel/main/popup-sentinel.user.js
```

In wBlock, add a userscript by URL and paste that address. The userscript's `downloadURL` and `updateURL` metadata point to the same stable file.

Popup Sentinel asks for no Greasemonkey privileges and runs in the page context at `document-start`.

## Development

Requirements: Node.js 20 or newer. No package installation is required.

```sh
npm test
```

To add another site, create a profile in the `profiles` array with narrowly scoped host, frame-path, popup-host, script-text, and HTML signatures. Add positive and negative policy tests before publishing.

## Debugging

Enable console logging for the current site:

```js
localStorage.setItem('popup-sentinel:debug', '1')
```

Disable it with:

```js
localStorage.removeItem('popup-sentinel:debug')
```

## Privacy and limitations

The userscript makes no network requests and stores no browsing data. Safari may inject userscripts after some parser-created scripts have started, so a targeted content-blocking rule remains the strongest way to stop a known network request. Popup Sentinel provides an additional page-level defense and a maintainable place for site-specific policies.

## License

MIT
