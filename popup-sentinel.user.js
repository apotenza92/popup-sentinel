// ==UserScript==
// @name         Popup Sentinel
// @namespace    https://github.com/apotenza92/popup-sentinel
// @version      0.0.7
// @description  Blocks verified popup generators while preserving legitimate new windows.
// @author       apotenza92
// @match        https://*/*
// @include      about:blank
// @run-at       document-start
// @inject-into  page
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/apotenza92/popup-sentinel/main/popup-sentinel.user.js
// @updateURL    https://raw.githubusercontent.com/apotenza92/popup-sentinel/main/popup-sentinel.user.js
// ==/UserScript==

(() => {
  'use strict';

  const profiles = [
    {
      id: 'streamed',
      pageHosts: new Set([
        'streamed.pk',
        'streamed.st',
        'streami.su',
        'embed.st',
        'embedhd.st',
      ]),
      runtimeHosts: new Set(['embed.st', 'embedhd.st']),
      blockedFramePaths: [/^\/ads?\.html(?:$|[?#])/i],
      verifiedPopupGenerators: [/\baclib\s*\.\s*runPop\s*\(/i],
      verifiedPopupLoaderURLs: [
        /^https:\/\/[^/]+\/(?:[a-f0-9]{2}\/){3}[a-f0-9]{32}\.js\?(?:[^#]*&)?mg=1(?:&[^#]*)?(?:#.*)?$/i,
      ],
      popupInteractionEvents: new Set([
        'click',
        'mousedown',
        'mouseup',
        'pointerdown',
        'pointerup',
        'touchstart',
        'touchend',
      ]),
      blockedInlineScriptText: [/adserverDomain/i],
      blockedHTML: [/<iframe\b[^>]*\bsrc\s*=\s*(['"])\/ads?\.html(?:[?#][^'"]*)?\1/i],
    },
  ];

  const normalizeHost = value => String(value || '').toLowerCase().replace(/^www\./, '');

  const hostMatches = (host, candidate) =>
    host === candidate || host.endsWith(`.${candidate}`);

  const setMatchesHost = (set, host) => {
    for (const candidate of set) {
      if (hostMatches(host, candidate)) return true;
    }
    return false;
  };

  const profileForHost = host => {
    const normalized = normalizeHost(host);
    return profiles.find(profile => setMatchesHost(profile.pageHosts, normalized));
  };

  const profileForContext = (host, referrerHosts = []) => {
    const directProfile = profileForHost(host);
    if (directProfile) return { profile: directProfile, trustedDownstream: false };

    for (const referrerHost of referrerHosts) {
      const normalized = normalizeHost(referrerHost);
      const profile = profiles.find(candidate =>
        setMatchesHost(candidate.runtimeHosts, normalized),
      );
      if (profile) return { profile, trustedDownstream: true };
    }
    return null;
  };

  const contextRestrictsExternalNavigation = (context, host) =>
    Boolean(
      context &&
      (
        context.trustedDownstream ||
        setMatchesHost(context.profile.runtimeHosts, normalizeHost(host))
      )
    );

  const contextMarkerPrefix = '__popup_sentinel_context_v1__:';

  const contextMarker = (profile, originalName = '') =>
    `${contextMarkerPrefix}${profile.id}:${encodeURIComponent(originalName)}`;

  const contextFromMarker = value => {
    const text = String(value || '');
    if (!text.startsWith(contextMarkerPrefix)) return null;
    const separator = text.indexOf(':', contextMarkerPrefix.length);
    if (separator === -1) return null;
    const profileId = text.slice(contextMarkerPrefix.length, separator);
    const profile = profiles.find(candidate => candidate.id === profileId);
    if (!profile) return null;
    let originalName = '';
    try {
      originalName = decodeURIComponent(text.slice(separator + 1));
    } catch {
      return null;
    }
    return {
      context: { profile, trustedDownstream: true },
      originalName,
    };
  };

  const toURL = (value, base = 'https://invalid.local/') => {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
      return new URL(value, base);
    } catch {
      return null;
    }
  };

  const isBlockedFrameURL = (profile, value, base, currentHost) => {
    const url = toURL(value, base);
    if (!url) return false;

    const pageURL = toURL(base);
    const host = normalizeHost(url.hostname);
    const normalizedCurrentHost = normalizeHost(currentHost);
    const currentHostIsRuntime = setMatchesHost(profile.runtimeHosts, normalizedCurrentHost);
    if (!currentHostIsRuntime) return false;

    const targetIsAdFrame =
      host === normalizedCurrentHost &&
      profile.blockedFramePaths.some(pattern =>
        pattern.test(`${url.pathname}${url.search}${url.hash}`),
      );
    if (targetIsAdFrame) return true;

    const pageIsAdFrame =
      pageURL &&
      normalizeHost(pageURL.hostname) === normalizedCurrentHost &&
      profile.blockedFramePaths.some(pattern =>
        pattern.test(`${pageURL.pathname}${pageURL.search}${pageURL.hash}`),
      );

    return (
      pageIsAdFrame &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !setMatchesHost(profile.pageHosts, host)
    );
  };

  const isExternalPopupURL = (profile, value, base, currentHost = '') => {
    const url = toURL(value, base);
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
    const host = normalizeHost(url.hostname);
    return (
      host !== normalizeHost(currentHost) &&
      !setMatchesHost(profile.pageHosts, host)
    );
  };

  const isBlankPopupURL = value => {
    if (value == null || String(value).trim() === '') return true;
    return /^about:blank(?:$|[?#])/i.test(String(value).trim());
  };

  const isBlockedPopupOpen = (
    profile,
    value,
    base,
    currentHost,
    verifiedGeneratorPresent,
    trustedDownstream = false,
  ) => {
    if (
      (!verifiedGeneratorPresent && !trustedDownstream) ||
      (
        !trustedDownstream &&
        !setMatchesHost(profile.pageHosts, normalizeHost(currentHost))
      )
    ) {
      return false;
    }

    return (
      isBlankPopupURL(value) ||
      isExternalPopupURL(profile, value, base, currentHost)
    );
  };

  const hasVerifiedPopupGenerator = (profile, scriptTexts) => {
    for (const text of scriptTexts) {
      if (profile.verifiedPopupGenerators.some(pattern => pattern.test(String(text || '')))) {
        return true;
      }
    }
    return false;
  };

  const isVerifiedPopupLoaderURL = (profile, value, base) => {
    const url = toURL(value, base);
    if (!url) return false;
    return profile.verifiedPopupLoaderURLs.some(pattern => pattern.test(url.href));
  };

  const shouldBlockPopupListener = (profile, type, scriptSrc, scriptText, base) =>
    profile.popupInteractionEvents.has(String(type || '').toLowerCase()) &&
    (
      isVerifiedPopupLoaderURL(profile, scriptSrc, base) ||
      hasVerifiedPopupGenerator(profile, [scriptText])
    );

  const isTransparentColor = value => {
    const normalized = String(value || '').toLowerCase().replace(/\s+/g, '');
    if (normalized === 'transparent') return true;

    const rgba = normalized.match(/^rgba\(\d+(?:\.\d+)?,\d+(?:\.\d+)?,\d+(?:\.\d+)?,(.+)\)$/);
    return rgba ? Number.parseFloat(rgba[1]) === 0 : false;
  };

  const isPopupOverlayStyle = (position, zIndex, opacity, backgroundColor) => {
    const parsedZIndex = Number.parseInt(String(zIndex || ''), 10);
    const parsedOpacity = Number.parseFloat(String(opacity || '1'));
    return (
      String(position || '').toLowerCase() === 'fixed' &&
      Number.isFinite(parsedZIndex) &&
      parsedZIndex >= 2147483640 &&
      Number.isFinite(parsedOpacity) &&
      (
        parsedOpacity <= 0.05 ||
        isTransparentColor(backgroundColor)
      )
    );
  };

  const testAPI = globalThis.__POPUP_SENTINEL_TEST__;
  if (testAPI && typeof testAPI === 'object') {
    Object.assign(testAPI, {
      profiles,
      profileForHost,
      profileForContext,
      contextRestrictsExternalNavigation,
      contextMarker,
      contextFromMarker,
      toURL,
      isBlockedFrameURL,
      isExternalPopupURL,
      isBlankPopupURL,
      isBlockedPopupOpen,
      hasVerifiedPopupGenerator,
      isVerifiedPopupLoaderURL,
      shouldBlockPopupListener,
      isTransparentColor,
      isPopupOverlayStyle,
    });
    return;
  }

  const contextReferrerHosts = () => {
    const hosts = [];
    let candidate = window;
    for (let depth = 0; depth < 5; depth += 1) {
      try {
        const referrer = toURL(candidate.document.referrer);
        if (referrer?.hostname) hosts.push(referrer.hostname);
        if (candidate.parent === candidate) break;
        candidate = candidate.parent;
      } catch {
        break;
      }
    }
    return hosts;
  };

  const baseHref = () => location.href;
  const currentHost = () => normalizeHost(location.hostname);
  const debugEnabled = (() => {
    try {
      return localStorage.getItem('popup-sentinel:debug') === '1';
    } catch {
      return false;
    }
  })();
  const log = (...args) => {
    if (debugEnabled) console.info('[Popup Sentinel]', ...args);
  };

  const verifiedPopupGeneratorPresent = profile =>
    hasVerifiedPopupGenerator(
      profile,
      Array.from(document.scripts, script => (script.src ? '' : script.textContent)),
    );

  const elementIsBlockedPopupOverlay = element => {
    if (!(element instanceof HTMLElement)) return false;
    if (
      !isPopupOverlayStyle(
        element.style.position,
        element.style.zIndex,
        element.style.opacity,
        element.style.backgroundColor,
      )
    ) {
      return false;
    }
    return (
      element.matches('a[target="_blank"]') ||
      Boolean(element.querySelector('a[target="_blank"]'))
    );
  };

  const markedContext = contextFromMarker(window.name);
  if (markedContext) window.name = markedContext.originalName;
  let activeContext =
    profileForContext(location.hostname, contextReferrerHosts()) ||
    markedContext?.context ||
    null;
  const contextRequestType = 'popup-sentinel:context-request:v1';
  const contextResponseType = 'popup-sentinel:context-response:v1';

  const isDirectChildWindow = candidate => {
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentWindow === candidate) return true;
      } catch {
        // A cross-origin child can still receive the response below.
      }
    }
    return false;
  };

  const markChildFrame = frame => {
    if (!(frame instanceof HTMLIFrameElement) || !activeContext) return;
    const name = frame.getAttribute('name') || '';
    if (!name.startsWith(contextMarkerPrefix)) {
      frame.setAttribute('name', contextMarker(activeContext.profile, name));
    }
  };

  const markChildFrames = root => {
    if (!activeContext || !(root instanceof Element || root instanceof Document)) return;
    if (root instanceof HTMLIFrameElement) markChildFrame(root);
    for (const frame of root.querySelectorAll('iframe')) markChildFrame(frame);
  };

  const sendContextTo = target => {
    if (!activeContext || !target) return;
    target.postMessage(
      {
        type: contextResponseType,
        profileId: activeContext.profile.id,
      },
      '*',
    );
  };

  addEventListener('message', event => {
    if (
      event.data?.type === contextRequestType &&
      activeContext &&
      isDirectChildWindow(event.source)
    ) {
      sendContextTo(event.source);
      return;
    }

    if (
      event.data?.type === contextResponseType &&
      !activeContext &&
      event.source === parent
    ) {
      const profile = profiles.find(candidate => candidate.id === event.data.profileId);
      if (profile) {
        activeContext = { profile, trustedDownstream: true };
        markChildFrames(document);
        for (const frame of document.querySelectorAll('iframe')) {
          sendContextTo(frame.contentWindow);
        }
      }
    }
  });

  if (!activeContext && parent !== window) {
    for (const delay of [0, 25, 100, 500, 2000]) {
      setTimeout(() => {
        if (!activeContext) {
          parent.postMessage({ type: contextRequestType }, '*');
        }
      }, delay);
    }
  }

  if (activeContext) markChildFrames(document);

  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) markChildFrames(node);
    }
  }).observe(document, { childList: true, subtree: true });

  const originalOpen = window.open;
  window.open = new Proxy(originalOpen, {
    apply(target, thisArg, args) {
      const context = activeContext;
      if (context) {
        const restrictExternalNavigation = contextRestrictsExternalNavigation(
          context,
          currentHost(),
        );
        if (
          isBlockedPopupOpen(
            context.profile,
            args[0],
            baseHref(),
            currentHost(),
            verifiedPopupGeneratorPresent(context.profile),
            restrictExternalNavigation,
          )
        ) {
          log('Blocked popup open from trusted player chain', args[0] || 'about:blank');
          return null;
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });

  addEventListener(
    'click',
    event => {
      const context = activeContext;
      if (!context) return;

      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const overlay = link?.closest('[style]');
      if (overlay && elementIsBlockedPopupOverlay(overlay)) {
        log('Blocked verified popup overlay click');
        event.preventDefault();
        event.stopImmediatePropagation();
        overlay.remove();
        return;
      }

      if (
        contextRestrictsExternalNavigation(context, currentHost()) &&
        link &&
        isExternalPopupURL(
          context.profile,
          link.getAttribute('href') || link.href,
          baseHref(),
          currentHost(),
        )
      ) {
        log('Blocked external navigation in trusted player chain');
        event.preventDefault();
        event.stopImmediatePropagation();
        link.remove();
      }
    },
    true,
  );

  const context = activeContext;
  if (!context) return;
  const { profile } = context;

  const frameIsBlocked = frame =>
    frame instanceof HTMLIFrameElement &&
    isBlockedFrameURL(profile, frame.getAttribute('src') || frame.src, baseHref(), currentHost());

  const scriptIsBlocked = script =>
    script instanceof HTMLScriptElement &&
    (
      isVerifiedPopupLoaderURL(profile, script.getAttribute('src') || script.src, baseHref()) ||
      profile.blockedInlineScriptText.some(pattern => pattern.test(script.textContent || ''))
    );

  const nodeIsBlocked = node =>
    frameIsBlocked(node) || scriptIsBlocked(node) || elementIsBlockedPopupOverlay(node);

  const removeBlockedDescendants = root => {
    if (!(root instanceof Element || root instanceof Document)) return;
    for (const frame of root.querySelectorAll('iframe[src]')) {
      if (frameIsBlocked(frame)) {
        log('Removed blocked frame', frame.src);
        frame.remove();
      }
    }
    for (const script of root.querySelectorAll('script:not([src])')) {
      if (scriptIsBlocked(script)) {
        log('Removed blocked inline advertising script');
        script.remove();
      }
    }
    for (const element of root.querySelectorAll('[style]')) {
      if (elementIsBlockedPopupOverlay(element)) {
        log('Removed verified popup overlay');
        element.remove();
      }
    }
  };

  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = new Proxy(originalAddEventListener, {
    apply(target, thisArg, args) {
      const currentScript = document.currentScript;
      if (
        currentScript instanceof HTMLScriptElement &&
        shouldBlockPopupListener(
          profile,
          args[0],
          currentScript.getAttribute('src') || currentScript.src,
          currentScript.textContent,
          baseHref(),
        )
      ) {
        log('Blocked verified popup interaction listener', args[0]);
        return undefined;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });

  const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = new Proxy(originalInsertAdjacentHTML, {
    apply(target, thisArg, args) {
      const html = args[1];
      if (
        typeof html === 'string' &&
        profile.blockedHTML.some(pattern => pattern.test(html))
      ) {
        log('Blocked known advertising HTML insertion');
        return undefined;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });

  const patchNodeInsertion = methodName => {
    const original = Node.prototype[methodName];
    Node.prototype[methodName] = new Proxy(original, {
      apply(target, thisArg, args) {
        const node = args[0];
        markChildFrames(node);
        if (nodeIsBlocked(node)) {
          log(`Blocked ${methodName}`, node.src || node.nodeName);
          return node;
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  };

  patchNodeInsertion('appendChild');
  patchNodeInsertion('insertBefore');
  patchNodeInsertion('replaceChild');

  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = new Proxy(originalSetAttribute, {
    apply(target, thisArg, args) {
      if (
        thisArg instanceof HTMLIFrameElement &&
        String(args[0]).toLowerCase() === 'src'
      ) {
        markChildFrame(thisArg);
      }
      if (
        thisArg instanceof HTMLIFrameElement &&
        String(args[0]).toLowerCase() === 'src' &&
        isBlockedFrameURL(profile, String(args[1]), baseHref(), currentHost())
      ) {
        log('Blocked iframe src assignment', args[1]);
        return undefined;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });

  const iframeSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  if (iframeSrcDescriptor?.get && iframeSrcDescriptor?.set) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: iframeSrcDescriptor.configurable,
      enumerable: iframeSrcDescriptor.enumerable,
      get: iframeSrcDescriptor.get,
      set(value) {
        markChildFrame(this);
        if (isBlockedFrameURL(profile, String(value), baseHref(), currentHost())) {
          log('Blocked iframe src property', value);
          return;
        }
        return Reflect.apply(iframeSrcDescriptor.set, this, [value]);
      },
    });
  }

  new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (nodeIsBlocked(node)) {
          log('Removed blocked node after insertion', node.src || node.nodeName);
          node.remove();
          continue;
        }
        removeBlockedDescendants(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  removeBlockedDescendants(document);
})();
