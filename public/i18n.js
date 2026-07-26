/* Scriptorium i18n engine.
 *
 * Loads locale data from /locales/{locale}.json and exposes a global __() function
 * for translation lookups with {variable} interpolation.
 *
 * The locale is persisted in localStorage and defaults to 'en'.
 * Changing locale updates the <html lang="..."> attribute and re-renders the UI.
 */

(function () {
  'use strict';

  var LOCALE_KEY = 'scriptorium_locale';
  var DEFAULT_LOCALE = 'en';

  // Load the saved locale before the page renders (sync from localStorage).
  var currentLocale = DEFAULT_LOCALE;
  try {
    var saved = localStorage.getItem(LOCALE_KEY);
    if (saved && /^[a-z]{2}(-[a-z]{2})?$/.test(saved)) currentLocale = saved;
  } catch (e) {}

  // Set <html lang="..."> immediately, before first paint.
  document.documentElement.setAttribute('lang', currentLocale);

  var localeData = null;
  var loadPromise = null;
  var callbacks = [];

  function notifyReady() {
    var cbs = callbacks;
    callbacks = [];
    cbs.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  // Fetch and cache the locale JSON.
  function loadLocale(locale) {
    var lang = locale || currentLocale;
    if (loadPromise && lang === currentLocale && localeData) return loadPromise;

    currentLocale = lang;
    document.documentElement.setAttribute('lang', currentLocale);
    try { localStorage.setItem(LOCALE_KEY, currentLocale); } catch (e) {}

    loadPromise = fetch('/locales/' + lang + '.json')
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load locale: ' + lang);
        return res.json();
      })
      .then(function (data) {
        localeData = data;
        notifyReady();
        return data;
      })
      .catch(function (err) {
        console.error('i18n: ' + err.message);
        localeData = null;
        notifyReady();
      });

    return loadPromise;
  }

  // The global translation function.
  // Usage: __('key') or __('key', { variable: 'value' })
  window.__ = function (key, vars) {
    if (!localeData) return key;

    var tmpl = localeData[key];
    if (tmpl === undefined || tmpl === null) return key;

    if (!vars) return tmpl;

    return tmpl.replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] !== undefined ? String(vars[k]) : m;
    });
  };

  // Apply i18n to all HTML elements with data-i18n* attributes.
  // Scans the DOM for:
  //   data-i18n="key"        -> sets element.textContent
  //   data-i18n-title="key"  -> sets element.title
  //   data-i18n-placeholder  -> sets element.placeholder
  //   data-i18n-aria-label   -> sets aria-label
  //   data-i18n-html="key"   -> sets element.innerHTML (use sparingly)
  function applyHtmlI18n(root) {
    root = root || document;
    if (!localeData) return;

    // textContent
    var els = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var key = els[i].getAttribute('data-i18n');
      if (key) els[i].textContent = window.__(key);
    }

    // title
    els = root.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < els.length; i++) {
      var tKey = els[i].getAttribute('data-i18n-title');
      if (tKey) els[i].title = window.__(tKey);
    }

    // placeholder
    els = root.querySelectorAll('[data-i18n-placeholder]');
    for (i = 0; i < els.length; i++) {
      var pKey = els[i].getAttribute('data-i18n-placeholder');
      if (pKey) els[i].placeholder = window.__(pKey);
    }

    // aria-label
    els = root.querySelectorAll('[data-i18n-aria-label]');
    for (i = 0; i < els.length; i++) {
      var aKey = els[i].getAttribute('data-i18n-aria-label');
      if (aKey) els[i].setAttribute('aria-label', window.__(aKey));
    }

    // innerHTML (for HTML-rich labels like font preview)
    els = root.querySelectorAll('[data-i18n-html]');
    for (i = 0; i < els.length; i++) {
      var hKey = els[i].getAttribute('data-i18n-html');
      if (hKey) els[i].innerHTML = window.__(hKey);
    }
  }
  window.applyHtmlI18n = applyHtmlI18n;

  // Change locale and reload the UI.
  window.setLocale = function (locale, cb) {
    if (locale === currentLocale && localeData) { if (cb) cb(); return; }
    loadLocale(locale).then(function () {
      // Update all HTML elements with data-i18n attributes
      applyHtmlI18n();

      // Re-run JS renderers
      if (typeof renderAll === 'function') renderAll();
      if (typeof updateLockStateUI === 'function') updateLockStateUI();
      if (typeof updateDocSortButton === 'function') updateDocSortButton();
      if (typeof updateBreadcrumbAndMeta === 'function') updateBreadcrumbAndMeta();
      if (typeof updateStats === 'function') updateStats();
      if (typeof renderColorThemeSwatches === 'function') renderColorThemeSwatches();
      if (typeof initFontSizeControls === 'function') initFontSizeControls();
      if (typeof renderSearchResults === 'function') {
        clearSearchHighlights(false);
      }
      if (cb) cb();
    }).catch(function () {
      if (cb) cb();
    });
  };

  // Returns the active locale code.
  window.getLocale = function () { return currentLocale; };

  // Init: load the saved locale on script execution.
  // Apply i18n to the DOM once it's ready.
  loadLocale(currentLocale).then(function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyHtmlI18n(); });
    } else {
      applyHtmlI18n();
    }
  });
})();
