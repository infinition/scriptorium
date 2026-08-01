/* Scriptorium i18n engine.
 *
 * Embeds English translations inline so __() always returns readable text
 * even before the async fetch completes. The fetch updates localeData with
 * the requested language (French, etc.) when it arrives.
 *
 * Usage: __(key) or __(key, { variable: 'value' })
 *        setLocale('fr') or setLocale('en')
 *        getLocale() -> 'en' | 'fr'
 */

(function () {
  'use strict';

  var LOCALE_KEY = 'scriptorium_locale';
  var DEFAULT_LOCALE = 'en';

  // --- Inline English fallback (guarantees __() never returns raw keys) ---
  var FALLBACK_EN = {"lang.name":"English","lang.flag":"\ud83c\uddec\ud83c\udde7","app.name":"Scriptorium","app.description":"Distraction-free markdown editor reading and writing .md files on your own disk.","nav.new_document":"New text","nav.new_section":"New section","nav.no_sections":"No sections. Create one with the button below.","nav.section_rename":"Cannot rename the General section","nav.general_section":"General","nav.section_rename_title":"Rename","nav.section_add_title":"Add doc","nav.section_delete_title":"Delete section","nav.doc_delete_title":"Delete","nav.doc_unsaved":"Unsaved","nav.doc_move_section":"Move to…","nav.doc_open_file":"Open the file","nav.doc_reveal":"Show in the file manager","nav.doc_copy_path":"Copy the path","nav.section_open_folder":"Open the folder","nav.doc_no_other_section":"No other section.","nav.import_title":"Import .md / .txt files","nav.workspace_tooltip":"Current workspace","lock.locked_title":"Locked mode: edits and deletion blocked","lock.unlocked_title":"Unlocked mode (click to lock)","lock.lock_aria":"Lock Scriptorium","lock.unlock_aria":"Unlock Scriptorium","lock.locked_alert":"The workspace is locked. Click the padlock at the top left to allow deletions.","lock.locked_alert_doc":"The workspace is locked. Click the padlock at the top left to allow deletions.","sidebar.reveal_title":"Show actions","header.search_title":"Search (Ctrl+P)","header.settings_title":"Settings","header.lock_title":"Lock / Unlock edits and deletions","header.open_folder_title":"Open in file manager","sort.by_date_tooltip":"Sort by modification date \u2014 click to sort A to Z","sort.by_alpha_tooltip":"Sort A to Z \u2014 click to sort by modification date","new_doc.placeholder_title":"Untitled","new_doc.placeholder_subtitle":"Subtitle, or a line to set the context","new_doc.placeholder_content":"Start writing\u2026","new_doc.placeholder_filename":"untitled","new_doc.default_title":"Untitled","new_doc.default_subtitle":"Subtitle, or a line to set the context","new_doc.default_content":"Start writing\u2026","save.saved":"Saved","save.modified":"Modified\u2026","save.error":"Save error","save.conflict":"Conflict","save.reloaded":"Reloaded","save.beacon_conflict":"Conflict \u2014 saved alongside","save.unsaved":"Unsaved changes","save.saved_ok":"Saved \u2713","confirm.doc_delete":"Permanently delete this document from disk?","confirm.section_delete_docs":"Section \"{name}\" contains {count} document(s). Permanently delete everything from disk?","confirm.section_delete_empty":"Delete section \"{name}\"?","confirm.theme_delete":"Delete ideas theme \"{name}\"?","confirm.theme_delete_custom":"Delete the colour theme \"{name}\"?","confirm.bg_delete":"Delete the background \"{name}\"?","confirm.conflict_keep":"This document was modified elsewhere since you opened it (other tab, phone, or external editor).\n\nOK \u2014 keep YOUR version and overwrite the disk\nCancel \u2014 reload the disk version (your unsaved changes are preserved in Ctrl+Z history)","confirm.restore_snapshot":"Restore snapshot \"{name}\"?\n\nThe current version will take its place in the list: click Restore again to go back.","alert.locked":"The workspace is locked. Click the padlock at the top left to allow deletions.","alert.token_missing":"Access token missing. Open the URL with ?token=\u2026 displayed at server startup.","alert.workspace_load_error":"Error loading workspace: {message}","alert.section_create_error":"Error creating section","alert.section_rename_error":"Error renaming section","alert.theme_create_error":"Error creating theme","alert.no_theme":"Please select or create an ideas theme first.","alert.section_general_rename":"Cannot rename the General section","alert.idea_delete_error":"Error deleting idea","alert.idea_edit_error":"Error editing idea","alert.config_save_error":"Error saving configuration","prompt.section_name":"Name of the new section (folder)?","prompt.theme_name":"Name of the theme?","prompt.color_theme_name":"Name of the new colour theme?","prompt.snapshot_name":"Snapshot name (e.g. Draft before cut):","prompt.url":"URL?","prompt.default_snapshot_name":"Revision of {date}, {time}","breadcrumb.no_doc":"No document","breadcrumb.filename_tooltip":"Click to copy the filename","breadcrumb.click_top_tooltip":"Click or tap to go to the top of the document","meta.created":"created {date}","meta.modified":"modified {date}","meta.copied":"\u2713 copied","theme.add":"+ theme","theme.tab_delete_title":"Delete","ideas.add_button":"+ add an idea","ideas.drop_to_add":"Drop to add the idea","ideas.no_theme":"No theme \u2014 create one with the + theme button.","ideas.empty_active":"No ideas \u2014 add one.","ideas.empty_archived":"No archived ideas.","ideas.insert_title":"Insert at cursor","ideas.edit_title":"Edit","ideas.archive_title":"Archive","ideas.unarchive_title":"Unarchive","ideas.delete_title":"Delete (5s to cancel)","ideas.pill_active":"Active","ideas.pill_archived":"Archive","ideas.input_placeholder":"New idea \u2014 Enter to confirm, Esc to cancel","ideas.footer":"click archives \u00b7 right-click inserts \u00b7 hover full text","ideas.import_theme_title":"Import .md theme","ideas.search_title":"Search ideas","ideas.search_placeholder":"Search ideas...","ideas.search_clear":"Clear","ideas.tab_ideas":"Ideas","ideas.tab_toc":"Contents","ideas.tab_snapshots":"Snapshots","toc.side_empty":"No headings in this document.","toc.top_button":"On this page","toc.top_button_title":"Back to top","panel.ideas_title":"Ideas","panel.cycle_tooltip":"Switch panel (click to cycle)","panel.toc_title":"Table of Contents","panel.snapshots_title":"Snapshots","snapshot.create_button":"+ Create a snapshot","snapshot.empty":"No snapshots saved for this document.","snapshot.view_diff":"Compare (Diff)","snapshot.restore":"Restore","snapshot.delete":"Delete","snapshot.close":"Close","snapshot.diff_title":"Comparison","snapshot.diff_meta":"Comparison between the current version and \"{name}\" (created {date})","snapshot.swapped_suffix":" \u2014 replaced version","workspace.title":"Welcome to Scriptorium","workspace.tagline":"Your writing companion.","workspace.desc":"Pick an existing folder, or type a new path to create it.","workspace.path_label":"Workspace folder:","workspace.path_placeholder":"C:\\path\\to\\workspace","workspace.hint":"The folder is created if it does not exist yet.","workspace.confirm":"Use this folder","workspace.path_required":"Enter a folder path first.","dialog.ok":"OK","dialog.confirm":"Confirm","dialog.cancel":"Cancel","dialog.title_confirm":"Confirmation","dialog.close":"Close","settings.title":"Settings","settings.tab_folders":"Folders","settings.tab_appearance":"Appearance","settings.tab_language":"Language","settings.folders_desc":"Set the local folders on your computer for your documents and ideas themes.","settings.documents_label":"Documents folder (Workspace):","settings.documents_placeholder":"C:\\\u2026\\workspace","settings.ideas_label":"Ideas folder (optional):","settings.ideas_placeholder":"Default: 'ideas' subfolder of the workspace","settings.ideas_hint":"Leave empty to use the 'ideas' folder inside the workspace.","settings.folder_browse_title":"Browse / Choose a folder","settings.appearance_desc":"Choose a visual theme. Changes are applied immediately.","settings.frontmatter_label":"Hide YAML frontmatter (block starting with \u00ab\u00a0---\u00a0\u00bb at the top of the document, e.g. Obsidian notes). Still preserved in the file.","settings.mdcolor_label":"Color headings (H1-H6), bold, quotes, links, code, strikethrough, etc. differently.","settings.custom_theme_desc":"Custom theme \u2014 saved in the folder","settings.custom_theme_desc_2":"of your workspace, one file per theme.","settings.new_theme_btn":"New theme","settings.theme_name_label":"Theme name","settings.theme_name_placeholder":"My theme","settings.delete_theme_btn":"Delete","settings.reset_theme_btn":"Reset to \"Default\" theme","settings.reset_theme_default_btn":"Reset theme to default","settings.save_theme_btn":"Save theme","settings.custom_status_unsaved":"Unsaved changes","settings.font_choice_desc":"Fonts for this theme: one for the interface, one for the editor.","settings.ui_font_label":"Interface font","settings.editor_font_label":"Editor font","settings.import_font_label":"Custom fonts","settings.import_font_btn":"Import… (.fonts)","settings.bg_desc":"App background: an image or video behind the whole interface.","settings.bg_label":"Background","settings.bg_none":"None","settings.bg_opacity_label":"Opacity","settings.bg_mosaic_label":"Mosaic (seamless repeating texture)","settings.bg_import_btn":"Import… (.media)","settings.bg_clear_btn":"No background","settings.bg_delete_title":"Delete this background","settings.color_alpha_title":"Opacity (transparency)","settings.font_sizes_desc":"Text size \u2014 each level is independently adjustable.","settings.font_doc_title_label":"Doc title","settings.font_doc_subtitle_label":"Doc subtitle","settings.font_base_label":"Body text","settings.font_h1_label":"Heading H1","settings.font_h2_label":"Heading H2","settings.font_h3_label":"Heading H3","settings.font_h4_label":"Heading H4","settings.font_h5_label":"Heading H5","settings.font_h6_label":"Heading H6","settings.reset_font_btn":"Reset sizes","settings.reading_fade_desc":"Typewriter reading fade: adjust the gradient intensity at the top and bottom edges.","settings.reading_fade_label":"Fade size","settings.block_gap_desc":"Space between blocks: the size of the line break between two paragraphs.","settings.block_gap_label":"Block spacing","settings.line_height_desc":"Line height of the blocks: the space above and below the text inside a block.","settings.line_height_label":"Line height","settings.cancel_btn":"Cancel","settings.save_btn":"Save","settings.language_desc":"Choose the application language. Changes apply immediately.","settings.language_select_label":"Language / Langue :","settings.syntax_colors_title":"Markdown element colors","appearance.theme_default":"Default","appearance.theme_ivoire":"Ivory","appearance.theme_polaire":"Polaire","appearance.theme_custom":"Custom","color.bg":"Background","color.bg_elevated":"Elevated bg","color.bg_hover":"Background (hover)","color.bg_active":"Background (active)","color.border":"Border","color.border_strong":"Strong border","color.text":"Text","color.text_muted":"Muted text","color.text_faint":"Faint text","color.accent":"Accent","color.danger":"Danger","color.syn_h1":"Heading H1","color.syn_h2":"Heading H2","color.syn_h3":"Heading H3","color.syn_h4":"Heading H4","color.syn_h5":"Heading H5","color.syn_h6":"Heading H6","color.syn_bold":"Bold","color.syn_quote":"Quote","color.syn_link":"Link","color.syn_code":"Code","color.syn_strike":"Strikethrough","topbar.typewriter_title":"Typewriter (T)","topbar.focus_line_title":"Paragraph focus (P)","topbar.reading_title":"Reading mode (R)","topbar.reading_typewriter_title":"Typewriter reading (R)","topbar.focus_title":"Focus mode (F)","topbar.export_title":"Export / Print (PDF Book, HTML, Markdown)","topbar.preview_title":"Preview (Ctrl+P)","topbar.clear_highlight_title":"Clear highlight","find.replace":"Replace","find.replace_all":"Replace all","find.placeholder":"Search\u2026","find.replace_placeholder":"Replace with\u2026","find.prev_title":"Previous (Shift+Enter)","find.next_title":"Next (Enter)","find.close_title":"Close (Esc)","find.match_case_title":"Match case","find.matches_ok":"{count} \u2713","search.placeholder":"Search documents and ideas\u2026","search.waiting":"Start typing to search across all your texts and ideas\u2026","search.no_results":"No results.","search.nav_up":"\u2191 \u2193 navigate","search.nav_open":"\u21B5 open","search.nav_close":"Esc close","search.result_doc":"doc","search.result_idea":"idea","search.result_idea_archived":"idea arch.","search.count":"{count} result","search.count_plural":"{count} results","search.section_general":"General","search.title":"Search","editor.block_paragraph":"Paragraph","editor.block_heading1":"Heading 1","editor.block_heading2":"Heading 2","editor.block_heading3":"Heading 3","editor.block_bullet_list":"Bullet list","editor.block_numbered_list":"Numbered list","editor.block_task":"Checkbox","editor.block_quote":"Quote","editor.block_code":"Code block","editor.block_image":"Image","editor.block_divider":"Divider","editor.block_menu_text":"Text","editor.block_menu_lists":"Lists","editor.block_menu_blocks":"Blocks","editor.block_menu_aria":"Block type","editor.block_add_title":"Add a block","editor.block_add_aria":"Add a block","editor.block_drag_title":"Drag to reorder the block","editor.block_drag_aria":"Move the block","editor.block_trash_title":"Delete the block","editor.block_trash_aria":"Delete the block","editor.block_empty_ghost":"(Empty block)","editor.selection_bold_title":"Bold (Ctrl+G)","editor.selection_italic_title":"Italic (Ctrl+I)","editor.selection_underline_title":"Underline","editor.selection_strike_title":"Strikethrough","editor.selection_code_title":"Inline code","editor.selection_link_title":"Link","editor.selection_heading1_title":"Heading 1","editor.selection_heading2_title":"Heading 2","editor.selection_heading3_title":"Heading 3","editor.selection_quote_title":"Quote","editor.selection_add_idea_title":"Add to ideas","editor.selection_toolbar_aria":"Formatting","multi.block_count":"{count} block","multi.block_count_plural":"{count} blocks","multi.merge_title":"Merge selected blocks into one (content and formatting preserved)","multi.delete_title":"Delete selected blocks","multi.merge_short":"Merge","multi.delete_short":"Delete","statusbar.mots":"words","statusbar.signes":"chars","statusbar.min":"min","statusbar.remove_empty_title":"Remove all empty lines from the document","statusbar.justify_title":"Justify text (align left and right)","statusbar.line_length_title":"Readable line length (toggle full width)","statusbar.spellcheck_title":"Spell check","statusbar.undo_title":"Undo (Ctrl+Z)","statusbar.redo_title":"Redo (Ctrl+Shift+Z)","statusbar.find_replace_title":"Find / Replace (Ctrl+F)","statusbar.autoscroll_title":"Auto-scroll (A)","statusbar.autoscroll_speed1_title":"Auto-scroll: very slow (A)","statusbar.autoscroll_speed2_title":"Auto-scroll: slow (A)","statusbar.autoscroll_speed3_title":"Auto-scroll: normal (A)","callout.tip":"Tip","callout.note":"Note","callout.success":"Success","callout.warning":"Warning","callout.danger":"Danger","callout.error":"Error","callout.quote":"Quote","callout.abstract":"Abstract","callout.todo":"To do","callout.question":"Question","callout.failure":"Failure","callout.bug":"Bug","callout.example":"Example","callout.cite":"Citation","callout.info":"Info","date.jan":"Jan","date.feb":"Feb","date.mar":"Mar","date.apr":"Apr","date.may":"May","date.jun":"Jun","date.jul":"Jul","date.aug":"Aug","date.sep":"Sep","date.oct":"Oct","date.nov":"Nov","date.dec":"Dec","date.today":"today","date.yesterday":"yesterday","server.error_path_missing":"Missing {label}","server.error_path_invalid":"Invalid {label}","server.error_path_separator":"{label} cannot contain a path separator","server.error_path_forbidden_char":"{label} contains a forbidden character","server.error_path_reserved":"{label} is a Windows reserved name","server.error_path_outside":"Path outside the workspace","server.error_invalid_doc_id":"Invalid document identifier","server.error_extension":"Only .md, .markdown and .txt files are accepted","server.error_workspace_locked":"Workspace locked","server.error_origin_refused":"Origin refused","server.error_host_refused":"Host refused","server.error_token_missing":"Access token missing or invalid","server.error_asset_missing":"Missing asset: {pkg} \u2014 run \"npm install\".","server.error_doc_not_found":"Document not found on disk","server.error_doc_conflict":"The file was modified elsewhere since you opened it","server.error_section_exists":"Section folder already exists","server.error_section_not_found":"Section folder not found","server.error_section_name_exists":"Section folder name already exists","server.error_cannot_delete_general":"Cannot delete the General section folder","server.error_source_not_found":"Source document not found on disk","server.error_theme_not_found":"Theme file not found","server.error_theme_exists":"Theme file already exists","server.error_folder_not_found":"Folder not found","server.error_picker_unavailable":"Native folder picker is only available on Windows \u2014 enter the path manually.","server.error_picker_failed":"Cannot open the folder picker","server.error_section_required":"Section is required","server.error_id_required":"ID is required","server.error_name_required":"Name is required","server.error_path_required":"Path is required","server.error_doc_id_required":"Document ID is required","server.error_oldid_newname":"Old ID and new name required","server.error_theme_id_required":"Theme ID and idea text are required","server.error_filename_content":"Filename and content required","server.error_docid_target":"Document ID and target section required","server.error_section_filename":"Section, filename, and content required","server.error_invalid_theme":"Invalid theme payload","server.error_save_theme":"Failed to save theme","server.error_snapshots":"Failed to read snapshots","server.error_save_snapshots":"Failed to save snapshots","server.error_scan_workspace":"Failed to scan workspace: {message}","server.error_locked_required":"locked (boolean) is required","server.warning_asset_missing":"Missing asset: {pkg} \u2014 run \"npm install\".","server.info_workspace":"Workspace: {path}","server.info_loopback":"Accessible from this machine only.","server.info_lan_exposed":"Exposed on the network ({host}) \u2014 access token required.","server.info_phone_url":"Phone: http://{addr}:{port}/?token={token}","server.info_lan_override":"Workspace overridden by SCRIPTORIUM_WORKSPACE: {path}","server.info_launch":"Scriptorium \u2014 http://localhost:{port}","export.title_pdf":"Print / PDF Book","export.title_html":"Export as standalone HTML","export.title_md":"Export as Markdown (.md)","math.error":"LaTeX error","drop.overlay_text":"Drop .md file(s)","drop.overlay_hint":"Drop on a section (left) to import as a document \u2014 on the ideas panel (right) to import a theme","sw.not_registered":"Service worker not registered: {message}","font_preview.doc_title":"Document Title","font_preview.doc_subtitle":"Document subtitle or description","font_preview.h1":"Main heading (H1)","font_preview.h2":"Section heading (H2)","font_preview.h3":"Subheading (H3)","font_preview.h4":"Heading H4","font_preview.h5":"Heading H5","font_preview.h6":"Heading H6","font_preview.quote":"An example quote for the style preview","font_preview.body":"Body text with <strong>bold</strong>, <em>italic</em>, <code>code</code>, a <a href=\"#\">link</a> and <del>strikethrough</del>.","toast.doc_saved":"Document saved","toast.doc_deleted":"Document deleted","toast.doc_conflict":"Conflict detected","toast.doc_reloaded":"Document reloaded","toast.section_created":"Section created","toast.section_renamed":"Section renamed","toast.section_deleted":"Section deleted","toast.theme_created":"Theme created","toast.theme_deleted":"Theme deleted","toast.idea_added":"Idea added","toast.idea_archived":"Idea archived","toast.idea_unarchived":"Idea unarchived","toast.idea_deleted":"Idea deleted","toast.idea_edited":"Idea edited","toast.filename_copied":"Filename copied","toast.snapshot_created":"Snapshot created","toast.snapshot_deleted":"Snapshot deleted","toast.snapshot_restored":"Snapshot restored","toast.settings_saved":"Settings saved","toast.workspace_set":"Workspace set","toast.workspace_locked":"Workspace locked","toast.workspace_unlocked":"Workspace unlocked","toast.doc_imported":"Document imported","toast.theme_imported":"Theme imported","toast.image_added":"Image inserted","toast.image_save_error":"Failed to save the image","toast.sort_changed":"Sort order changed","toast.lang_changed":"Language changed to {lang}","toast.blocks_merged":"Blocks merged","toast.blocks_deleted":"Blocks deleted","toast.text_justified":"Text justified","toast.line_length_on":"Full line length","toast.line_length_off":"Readable line length","toast.spellcheck_toggled":"Spell check {state}","toast.typewriter_on":"Typewriter mode on","toast.typewriter_off":"Typewriter mode off","toast.focus_line_on":"Paragraph focus on","toast.focus_line_off":"Paragraph focus off","toast.reading_on":"Reading mode on","toast.reading_off":"Reading mode off","toast.reading_typewriter_on":"Typewriter reading on","toast.autoscroll_speed1":"Auto-scroll: very slow","toast.autoscroll_speed2":"Auto-scroll: slow","toast.autoscroll_speed3":"Auto-scroll: normal","toast.autoscroll_off":"Auto-scroll off","toast.autoscroll_paused":"Auto-scroll paused (click to resume)","toast.focus_on":"Focus mode on","toast.focus_off":"Focus mode off","toast.empty_lines_removed":"Empty lines removed","toast.no_empty_lines":"No empty lines to remove","toast.theme_applied":"Theme applied","toast.theme_reset":"Theme reset to default","toast.font_imported":"Fonts imported","toast.media_imported":"Background media imported","toast.media_deleted":"Background deleted","toast.custom_theme_saved":"Custom theme saved","toast.state_on":"on","toast.state_off":"off","toast.doc_created":"Document created","toast.doc_moved":"Document moved","toast.open_failed":"Cannot open the file","toast.path_copied":"Path copied","toast.doc_duplicated":"Document duplicated","toast.doc_deleted_undo":"Document deleted","toast.undo_btn":"Undo","toast.doc_restored":"Document restored","toast.external_change":"Workspace modified externally","nav.doc_duplicate":"Duplicate"};

  // Load the saved locale before the page renders (sync from localStorage).
  var currentLocale = DEFAULT_LOCALE;
  try {
    var saved = localStorage.getItem(LOCALE_KEY);
    if (saved && /^[a-z]{2}(-[a-z]{2})?$/.test(saved)) currentLocale = saved;
  } catch (e) {}

  document.documentElement.setAttribute('lang', currentLocale);

  // Start with English inline fallback so __() never returns raw keys.
  // The async fetch will overwrite this with the requested locale's data.
  var localeData = FALLBACK_EN;
  var loadPromise = null;

  // Fetch and cache the locale JSON.
  function loadLocale(locale) {
    var lang = locale || currentLocale;
    if (lang === 'en') {
      // English is already inlined; no fetch needed.
      localeData = FALLBACK_EN;
      currentLocale = lang;
      document.documentElement.setAttribute('lang', currentLocale);
      try { localStorage.setItem(LOCALE_KEY, currentLocale); } catch (e) {}
      return Promise.resolve();
    }
    if (loadPromise && lang === currentLocale) return loadPromise;

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
        return data;
      })
      .catch(function (err) {
        console.error('i18n: ' + err.message);
        localeData = FALLBACK_EN;
      });

    return loadPromise;
  }

  // The global translation function.
  // Guaranteed to return a readable string: English fallback is always inlined.
  window.__ = function (key, vars) {
    var tmpl = localeData && localeData[key];
    if (tmpl === undefined || tmpl === null) tmpl = FALLBACK_EN[key];
    if (tmpl === undefined || tmpl === null) return key;

    if (!vars) return tmpl;

    return tmpl.replace(/\{(\w+)\}/g, function (m, k) {
      return vars[k] !== undefined ? String(vars[k]) : m;
    });
  };

  // Apply i18n to HTML elements with data-i18n* attributes.
  function applyHtmlI18n(root) {
    root = root || document;
    var els, i, key, tKey, pKey, aKey, hKey;

    els = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < els.length; i++) { key = els[i].getAttribute('data-i18n'); if (key) els[i].textContent = window.__(key); }

    els = root.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < els.length; i++) { tKey = els[i].getAttribute('data-i18n-title'); if (tKey) els[i].title = window.__(tKey); }

    els = root.querySelectorAll('[data-i18n-placeholder]');
    for (i = 0; i < els.length; i++) { pKey = els[i].getAttribute('data-i18n-placeholder'); if (pKey) els[i].placeholder = window.__(pKey); }

    els = root.querySelectorAll('[data-i18n-aria-label]');
    for (i = 0; i < els.length; i++) { aKey = els[i].getAttribute('data-i18n-aria-label'); if (aKey) els[i].setAttribute('aria-label', window.__(aKey)); }

    els = root.querySelectorAll('[data-i18n-html]');
    for (i = 0; i < els.length; i++) { hKey = els[i].getAttribute('data-i18n-html'); if (hKey) els[i].innerHTML = window.__(hKey); }
  }
  window.applyHtmlI18n = applyHtmlI18n;

  // Change locale and reload the UI.
  window.setLocale = function (locale, cb) {
    if (locale === currentLocale && locale === 'en') { if (cb) cb(); return; }
    loadLocale(locale).then(function () {
      applyHtmlI18n();
      if (typeof renderAll === 'function') renderAll();
      if (typeof updateLockStateUI === 'function') updateLockStateUI();
      if (typeof updateDocSortButton === 'function') updateDocSortButton();
      if (typeof updateStats === 'function') updateStats();
      if (typeof renderColorThemeSwatches === 'function') renderColorThemeSwatches();
      if (typeof clearSearchHighlights === 'function') clearSearchHighlights(false);
      if (cb) cb();
    }).catch(function () { if (cb) cb(); });
  };

  window.getLocale = function () { return currentLocale; };

  // Init: English is already in localeData; fetch French if needed.
  if (currentLocale !== 'en') {
    loadLocale(currentLocale).then(function () {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { applyHtmlI18n(); });
      } else {
        applyHtmlI18n();
      }
    });
  } else {
    // English is ready immediately; apply on DOMContentLoaded.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { applyHtmlI18n(); });
    } else {
      applyHtmlI18n();
    }
  }
})();
