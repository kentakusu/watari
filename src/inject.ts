// 窓の中で動く小さなスクリプト。ページのスクリプトからは見えない別世界（isolated world）で動く。
// 役目: 名札と「今触ってる」ボタンを出す・宣言された要素を見張り、値が変わったら渡へ知らせる。

export type WatchDecl = { ext: string; name: string; selector: string; read?: string; sites: string[] };
export type InjectConfig = { label: string; watches: WatchDecl[] };

export const WORLD = 'watari';
export const BINDING = '__watari';

/** サイトの宣言（`*` だけが特別な glob）を正規表現の文字列にする。 */
export function globSource(glob: string): string {
  return '^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*') + '$';
}

export function siteMatches(sites: string[], url: string): boolean {
  return sites.some((s) => new RegExp(globSource(s)).test(url));
}

export function pageScript(cfg: InjectConfig): string {
  const watches = cfg.watches.map((w) => ({ ...w, siteRe: w.sites.map(globSource) }));
  return `(() => {
  if (globalThis.__watariLoaded) return;
  globalThis.__watariLoaded = true;
  const cfg = ${JSON.stringify({ label: cfg.label, watches })};
  const send = (o) => { try { globalThis.${BINDING}(JSON.stringify(o)); } catch (e) {} };
  const href = location.href;
  const watches = cfg.watches.filter((w) => w.siteRe.some((s) => new RegExp(s).test(href)));

  // 名札
  let touching = false;
  const mountTag = () => {
    const host = document.createElement('watari-tag');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' +
      '.t{font:12px/1.4 system-ui,sans-serif;display:flex;gap:6px;align-items:center;background:#1f1e1c;color:#f6f4ef;border-radius:8px;padding:4px 6px;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
      '.t:hover{opacity:1}button{font:inherit;border:1px solid #6a675f;background:transparent;color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer}' +
      'button.on{background:#d9772b;border-color:#d9772b;color:#1f1e1c}.n{white-space:nowrap}.f .n,.f .h{display:none}' +
      '</style><div class="t"><span class="n"></span><button class="h" type="button">今触ってる</button><button class="x" type="button" aria-label="畳む">–</button></div>';
    root.querySelector('.n').textContent = '渡: ' + cfg.label;
    const h = root.querySelector('.h');
    h.addEventListener('click', () => { touching = !touching; h.classList.toggle('on', touching); h.textContent = touching ? '触ってる（自動は待機中）' : '今触ってる'; send({ type: 'touch', on: touching }); });
    root.querySelector('.x').addEventListener('click', () => root.querySelector('.t').classList.toggle('f'));
    document.documentElement.appendChild(host);
  };

  // 見張り
  const last = new Map();
  const valueOf = (w) => {
    const el = document.querySelector(w.selector);
    if (!el) return { missing: true, value: null };
    const v = !w.read || w.read === 'text' ? (el.textContent || '').trim() : el.getAttribute(w.read);
    return { missing: false, value: v };
  };
  const check = () => {
    for (const w of watches) {
      const r = valueOf(w);
      const key = w.ext + '/' + w.name;
      const prev = last.get(key);
      if (prev && prev.missing === r.missing && prev.value === r.value) continue;
      last.set(key, r);
      send({ type: 'watch', ext: w.ext, name: w.name, missing: r.missing, value: r.value, previous: prev ? prev.value : undefined, url: location.href });
    }
  };
  // 時間でまとめない。まとめると 1→0→1 のような往復が「変化なし」に潰れ、新着を落とす。
  // MutationObserver は 1 つの処理（タスク）の中の変化を 1 回にまとめて渡すので、その単位で見る。

  const start = () => {
    mountTag();
    send({ type: 'ready', url: location.href, watches: watches.length });
    if (!watches.length) return;
    check();
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();`;
}
