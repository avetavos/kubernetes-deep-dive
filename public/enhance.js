(() => {
  if (window.__enhanced) return;
  window.__enhanced = true;

  // ---- Read mode ----
  const KEY = 'readmode';
  function apply(on) { document.documentElement.classList.toggle('read-mode', on); }
  function initReadMode() {
    const saved = localStorage.getItem(KEY) === '1';
    apply(saved);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'readmode-toggle';
    btn.textContent = saved ? 'Exit read mode' : 'Read mode';
    btn.setAttribute('aria-pressed', String(saved));
    btn.addEventListener('click', () => {
      const on = !document.documentElement.classList.contains('read-mode');
      apply(on);
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? 'Exit read mode' : 'Read mode';
      try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
    });
    document.body.appendChild(btn);
  }

  // ---- Mermaid ----
  let mermaid = null;
  let pass = 0;
  function theme() {
    return document.documentElement.dataset.theme === 'light' ? 'default' : 'dark';
  }
  async function render() {
    const nodes = Array.from(document.querySelectorAll('pre.mermaid'));
    if (!nodes.length) return;
    if (!mermaid) {
      try {
        mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default;
      } catch (e) { console.error('mermaid load failed', e); return; }
    }
    mermaid.initialize({ startOnLoad: false, theme: theme(), securityLevel: 'strict' });
    pass += 1;
    let i = 0;
    for (const n of nodes) {
      if (!n.dataset.src) n.dataset.src = n.textContent;
      try {
        const { svg } = await mermaid.render('mmd-' + pass + '-' + (i++), n.dataset.src);
        n.innerHTML = svg;
        n.setAttribute('data-processed', 'true');
      } catch (e) { console.error('mermaid render', e); }
    }
  }

  function init() {
    initReadMode();
    render();
    new MutationObserver((m) => {
      if (m.some((x) => x.attributeName === 'data-theme')) render();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

;(() => {
  if (window.__sidebarCollapse) return;
  window.__sidebarCollapse = true;
  const KEY = 'sidebar-collapsed';
  const root = document.documentElement;
  function set(on) { root.classList.toggle('sidebar-collapsed', on); }
  function init() {
    if (!document.querySelector('.sidebar-pane, .sidebar')) return;
    set(localStorage.getItem(KEY) === '1');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar-collapse-toggle';
    function sync() {
      const on = root.classList.contains('sidebar-collapsed');
      btn.innerHTML = on ? '&rsaquo;' : '&lsaquo;';
      btn.title = on ? 'Expand sidebar' : 'Collapse sidebar';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', String(on));
    }
    sync();
    btn.addEventListener('click', () => {
      set(!root.classList.contains('sidebar-collapsed'));
      try { localStorage.setItem(KEY, root.classList.contains('sidebar-collapsed') ? '1' : '0'); } catch (e) {}
      sync();
    });
    document.body.appendChild(btn);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
