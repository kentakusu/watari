// 試験用: パイプで Chrome を起こして居座る持ち主。外から強制終了される役（落ちた渡の代わり）。
import { launchChrome } from '../../src/chrome.ts';
const b = await launchChrome({ profileDir: process.argv[2], headless: true });
process.stdout.write(`READY ${b.process.pid}\n`);
setInterval(() => {}, 1000);
