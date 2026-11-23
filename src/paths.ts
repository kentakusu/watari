// WSL の中から使うときの道のりの直し。

/**
 * WSL の中で動いているとき、/mnt/d/... の道のりを、常駐（Windows）が読める D:\... に直す。
 * WSL の中だけにある道のり（/home/... 等）は Windows の常駐から読めないので、断る。
 */
export function pathForDaemon(p: string, inWsl = process.platform === 'linux' && !!process.env.WSL_DISTRO_NAME): string {
  if (!inWsl) return p;
  const m = p.match(/^\/mnt\/([a-z])(\/.*)?$/i);
  if (!m) throw new Error(`WSL の中だけにある場所は、Windows で動く渡から読めません。/mnt/<ドライブ>/ の下に置いてください: ${p}`);
  return `${m[1].toUpperCase()}:${(m[2] ?? '/').replaceAll('/', '\\')}`;
}
