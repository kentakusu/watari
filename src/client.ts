// 常駐（daemon）へ話しかける client。MCP とトレイが使う。
import { readConfig, readToken } from './home.ts';

export class DaemonDown extends Error {}

export function client(home: string) {
  const call = async (method: string, params: object = {}): Promise<any> => {
    const { port } = readConfig(home);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken(home)}` },
        body: JSON.stringify({ method, params }),
      });
    } catch (e: any) {
      throw new DaemonDown(`渡が動いていません（127.0.0.1:${port} に届きません）。タスクトレイから渡を起動してください: ${e?.cause?.code ?? e?.message}`);
    }
    const body = (await res.json()) as any;
    if (!res.ok || body.error) throw new Error(body.error ?? `渡が ${res.status} を返しました`);
    return body.result;
  };
  return { call };
}
