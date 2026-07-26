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

  const LOCALE_KEY = 'scriptorium_locale';
  const DEFAULT_LOCALE = 'en';

  // Load the saved locale before the page renders (sync from localStorage).
  let currentLocale = DEFAULT_LOCALE;
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved && /^[a-z]{2}(-[a-z]{2})?$/.test(saved)) currentLocale = saved;
  } catch (e) {}

  // Set <html lang="..."> immediately, before first paint.
  document.documentElement.setAttribute('lang', currentLocale);

  let localeData = null;
  let loadPromise = null;
  let callbacks = [];

  function onLocaleReady(fn) {
    if (localeData) { fn(); return; }
    callbacks.push(fn);
  }

  function notifyReady() {
    const cbs = callbacks;
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
        // Fallback to inline minimal translations
        localeData = null;
        notifyReady();
      });

    return loadPromise;
  }

  // The global translation function.
  // Usage: __('key') or __('key', { variable: 'value' })
  window.__ = function (key, vars) {
    // During initial load, try to get data from inline cache
    if (!localeData) {
      // Return the key itself as a fallback so the UI is never blank
      return key;
    }

    var tmpl = localeData[key];
    if (tmpl === undefined || tmpl === null) {
      // Fallback: try English
      return key;
    }

    if (!vars) return tmpl;

    return tmpl.replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] !== undefined ? String(vars[k]) : m;
    });
  };

  // Change locale and reload the UI.
  window.setLocale = function (locale, cb) {
    if (locale === currentLocale && localeData) { if (cb) cb(); return; }
    loadLocale(locale).then(function () {
      if (typeof renderAll === 'function') renderAll();
      if (typeof updateLockStateUI === 'function') updateLockStateUI();
      if (typeof updateDocSortButton === 'function') updateDocSortButton();
      if (typeof updateBreadcrumbAndMeta === 'function') updateBreadcrumbAndMeta();
      if (typeof updateStats === 'function') updateStats();
      if (typeof renderSearchResults === 'function') {
        var q = document.getElementById('searchInput');
        if (q && q.value) {
          // Re-run search with new locale labels
          clearSearchHighlights(false);
        }
      }
      if (cb) cb();
    }).catch(function () {
      if (cb) cb();
    });
  };

  // Returns the active locale code.
  window.getLocale = function () { return currentLocale; };

  // Returns true when locale data has loaded.
  window.isLocaleReady = function () { return localeData !== null; };

  // Init: load the saved locale on script execution.
  loadLocale(currentLocale);
})();
