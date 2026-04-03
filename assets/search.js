/**
 * Online Dev Tools — Global Search (Ctrl+K / Cmd+K)
 * Self-contained; attach via <script src="/assets/search.js" defer>
 * Works alongside header.html partial injection.
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────
  let posts     = null;
  let loading   = false;
  let focusIdx  = -1;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function esc(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function $(id) { return document.getElementById(id); }

  // ── Data ─────────────────────────────────────────────────────────────────
  async function loadPosts() {
    if (posts || loading) return;
    loading = true;
    try {
      const r    = await fetch('/blog/posts.json', { cache: 'no-cache' });
      const data = await r.json();
      posts = Array.isArray(data.posts) ? data.posts : [];
    } catch (_) {
      posts = [];
    }
    loading = false;
    // Render immediately if input has value
    const inp = $('odt-search-input');
    if (inp) renderResults(inp.value.trim().toLowerCase());
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function renderResults(query) {
    const list  = $('odt-search-results');
    const empty = $('odt-search-empty');
    if (!list) return;

    const all = posts || [];
    const filtered = query
      ? all.filter(p =>
          (p.title || '').toLowerCase().includes(query) ||
          (p.description || '').toLowerCase().includes(query)
        )
      : all.slice(0, 6);

    focusIdx = -1;

    if (filtered.length === 0 && query) {
      list.innerHTML = '';
      if (empty) empty.removeAttribute('hidden');
    } else {
      if (empty) empty.setAttribute('hidden', '');
      list.innerHTML = filtered.map((p, i) => {
        const cat = p.category ? `<span class="search-result-cat">${esc(p.category)}</span>` : '';
        return `<li role="option">
          <a href="/blog/${esc(p.slug)}" class="search-result-link" data-idx="${i}">
            ${cat}
            <strong>${esc(p.title)}</strong>
            <span>${esc(p.description || '')}</span>
          </a>
        </li>`;
      }).join('');
    }
  }

  // ── Keyboard focus navigation ─────────────────────────────────────────────
  function moveFocus(dir) {
    const links = document.querySelectorAll('#odt-search-results .search-result-link');
    if (!links.length) return;
    focusIdx = Math.min(Math.max(focusIdx + dir, 0), links.length - 1);
    links[focusIdx].focus();
  }

  // ── Open / Close ─────────────────────────────────────────────────────────
  function openSearch() {
    const overlay = $('odt-search');
    if (!overlay) return;
    overlay.removeAttribute('hidden');
    document.body.style.overflow = 'hidden';
    const inp = $('odt-search-input');
    if (inp) {
      inp.value = '';
      inp.focus();
    }
    loadPosts().then(() => renderResults(''));
  }

  function closeSearch() {
    const overlay = $('odt-search');
    if (!overlay) return;
    overlay.setAttribute('hidden', '');
    document.body.style.overflow = '';
    focusIdx = -1;
  }

  // ── Fix keyboard shortcut label (Ctrl on Windows/Linux, ⌘ on Mac) ────────
  function updateShortcutLabel() {
    const el = $('odt-search-shortcut');
    if (!el) return;
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    el.textContent = isMac ? '⌘K' : 'Ctrl+K';
  }

  // ── Event listeners (document-level for async header injection compat) ────
  document.addEventListener('keydown', function (e) {
    const isK = e.key === 'k' || e.key === 'K';

    // Open: Ctrl+K / Cmd+K
    if ((e.metaKey || e.ctrlKey) && isK) {
      e.preventDefault();
      const overlay = $('odt-search');
      if (overlay && overlay.hasAttribute('hidden')) {
        openSearch();
      } else {
        closeSearch();
      }
      return;
    }

    const overlay = $('odt-search');
    if (!overlay || overlay.hasAttribute('hidden')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
      return;
    }

    if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); moveFocus(-1); }

    if (e.key === 'Enter') {
      const active = document.activeElement;
      if (active && active.classList.contains('search-result-link')) {
        window.location.href = active.href;
        closeSearch();
      } else if ($('odt-search-input') === active) {
        const first = document.querySelector('#odt-search-results .search-result-link');
        if (first) { window.location.href = first.href; closeSearch(); }
      }
    }
  });

  document.addEventListener('click', function (e) {
    // Open via trigger button
    if (e.target.closest('#odt-search-btn')) { openSearch(); return; }
    // Close via backdrop or ESC button
    if (e.target.id === 'odt-search-backdrop' || e.target.id === 'odt-search-close') {
      closeSearch();
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id !== 'odt-search-input') return;
    const q = e.target.value.trim().toLowerCase();
    if (!posts && !loading) {
      loadPosts();
    } else {
      renderResults(q);
    }
  });

  // ── Init after DOM ready ──────────────────────────────────────────────────
  function init() {
    updateShortcutLabel();
    // Pre-load posts in background for snappier first open
    setTimeout(loadPosts, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
