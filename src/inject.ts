// 窓の中で動く小さなスクリプト。ページのスクリプトからは見えない別世界（isolated world）で動く。
// 役目: 名札と「今触ってる」ボタンを出す・宣言された要素を見張り、値が変わったら渡へ知らせる。
// 拡張の出し入れで見張りが変わるので、設定はあとから差し替えられる（__watariConfigure）。

export type WatchDecl = { ext: string; name: string; selector: string; read?: string; sites: string[] };
export type InjectConfig = { label: string; watches: WatchDecl[]; missingGraceMs: number };

export const WORLD = 'watari';
export const BINDING = '__watari';

/** サイトの宣言（`*` だけが特別な glob）を正規表現の文字列にする。 */
export function globSource(glob: string): string {
  return '^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*') + '$';
}

export function siteMatches(sites: string[], url: string): boolean {
  return sites.some((s) => new RegExp(globSource(s)).test(url));
}

export function pageConfig(cfg: InjectConfig): object {
  return { ...cfg, watches: cfg.watches.map((w) => ({ ...w, siteRe: w.sites.map(globSource) })) };
}

/** 新しい文書ごとに走らせる本体。最後に __watariConfigure(cfg) を呼ぶ。 */
export function pageScript(cfg: InjectConfig): string {
  return `${RUNTIME}\nglobalThis.__watariConfigure(${JSON.stringify(pageConfig(cfg))});`;
}

/** 走っている窓の設定を差し替える式。 */
export function reconfigureExpression(cfg: InjectConfig): string {
  return `globalThis.__watariConfigure && globalThis.__watariConfigure(${JSON.stringify(pageConfig(cfg))})`;
}

const RUNTIME = `(() => {
  const g = globalThis;
  if (g.__watariConfigure) return;
  const send = (o) => { try { g.${BINDING}(JSON.stringify(o)); } catch (e) {} };
  let cfg = { label: '', watches: [], missingGraceMs: 10000 };
  let watches = [];
  let started = false;
  let nameEl = null;
  const last = new Map();
  const pendingMissing = new Map();

  // 名札
  const mountTag = () => {
    const host = document.createElement('watari-tag');
    host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' +
      '.t{font:12px/1.4 system-ui,sans-serif;display:flex;gap:6px;align-items:center;background:#1f1e1c;color:#f6f4ef;border-radius:8px;padding:4px 6px;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
      '.t:hover{opacity:1}button{font:inherit;border:1px solid #6a675f;background:transparent;color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer}' +
      'button.on{background:#d9772b;border-color:#d9772b;color:#1f1e1c}.n{white-space:nowrap}.f .n,.f .h{display:none}' +
      '</style><div class="t"><span class="n"></span><button class="h" type="button">今触ってる</button><button class="x" type="button" aria-label="畳む">–</button></div>';
    nameEl = root.querySelector('.n');
    nameEl.textContent = '渡: ' + cfg.label;
    const h = root.querySelector('.h');
    let touching = false;
    g.__watariShowTouching = (on) => { touching = on; h.classList.toggle('on', on); h.textContent = on ? '触ってる（自動は待機中）' : '今触ってる'; };
    h.addEventListener('click', () => { g.__watariShowTouching(!touching); send({ type: 'touch', on: touching }); });
    root.querySelector('.x').addEventListener('click', () => root.querySelector('.t').classList.toggle('f'));
    document.documentElement.appendChild(host);
  };

  // 見張り
  const valueOf = (w) => {
    const el = document.querySelector(w.selector);
    if (!el) return { missing: true, value: null };
    const v = !w.read || w.read === 'text' ? (el.textContent || '').trim() : el.getAttribute(w.read);
    return { missing: false, value: v };
  };
  const report = (w, key, r) => {
    const prev = last.get(key);
    last.set(key, r);
    send({ type: 'watch', ext: w.ext, name: w.name, missing: r.missing, value: r.value, previous: prev ? prev.value : undefined, url: location.href });
  };
  // 時間でまとめない。まとめると 1→0→1 のような往復が「変化なし」に潰れ、新着を落とす。
  // MutationObserver は 1 つの処理（タスク）の中の変化を 1 回にまとめて渡すので、その単位で見る。
  const check = () => {
    if (!started) return;
    for (const w of watches) {
      const key = w.ext + '/' + w.name;
      const r = valueOf(w);
      const prev = last.get(key);
      if (r.missing) {
        if (prev && prev.missing) continue;
        // 描画が遅い画面で「見つからない」と騒がないよう、しばらく見つからないままのときだけ知らせる
        if (!pendingMissing.has(key)) {
          pendingMissing.set(key, setTimeout(() => {
            pendingMissing.delete(key);
            const again = valueOf(w);
            if (again.missing) report(w, key, again); else check();
          }, cfg.missingGraceMs));
        }
        continue;
      }
      if (pendingMissing.has(key)) { clearTimeout(pendingMissing.get(key)); pendingMissing.delete(key); }
      if (prev && !prev.missing && prev.value === r.value) continue;
      report(w, key, r);
    }
  };

  g.__watariConfigure = (next) => {
    cfg = next;
    const href = location.href;
    watches = cfg.watches.filter((w) => w.siteRe.some((s) => new RegExp(s).test(href)));
    const keys = new Set(watches.map((w) => w.ext + '/' + w.name));
    for (const k of [...last.keys()]) if (!keys.has(k)) last.delete(k);
    for (const [k, t] of [...pendingMissing]) if (!keys.has(k)) { clearTimeout(t); pendingMissing.delete(k); }
    if (nameEl) nameEl.textContent = '渡: ' + cfg.label;
    if (started) { send({ type: 'ready', url: href, watches: watches.length }); check(); }
  };

  const start = () => {
    started = true;
    mountTag();
    send({ type: 'ready', url: location.href, watches: watches.length });
    check();
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();`;
