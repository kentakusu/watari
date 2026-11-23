// MQTT のパケットを開く（WebSocket の上の MQTT を読むため）。外の部品は使わない。
// 1 つのフレームに入っている複数のパケットを順に開く。PUBLISH は topic と中身を取り出す。
// 版は 4（3.1.1）と 5。版 5 では PUBLISH の properties を読み飛ばす。
// 途中で切れているもの（フレームをまたぐもの）は truncated を立てて返す（黙って捨てない）。

export const MQTT_TYPES = ['', 'CONNECT', 'CONNACK', 'PUBLISH', 'PUBACK', 'PUBREC', 'PUBREL', 'PUBCOMP', 'SUBSCRIBE', 'SUBACK', 'UNSUBSCRIBE', 'UNSUBACK', 'PINGREQ', 'PINGRESP', 'DISCONNECT', 'AUTH'] as const;

export type MqttPacket = {
  type: number;
  typeName: string;
  /** PUBLISH のとき */
  topic?: string;
  qos?: number;
  retain?: boolean;
  dup?: boolean;
  packetId?: number;
  /** 中身（base64） */
  payload?: string;
  /** 中身を UTF-8 として読めたら、その文字列 */
  payloadText?: string;
  /** 中身の文字列が JSON として読めたら、その値 */
  payloadJson?: unknown;
  /** パケットがフレームの途中で切れている */
  truncated?: boolean;
  /** パケットの中の長さが合わない（理由）。そこで読むのをやめている */
  malformed?: string;
};

function readVarInt(b: Buffer, at: number): { value: number; size: number } | null {
  let value = 0, mul = 1;
  for (let i = 0; i < 4; i++) {
    if (at + i >= b.length) return null;
    const byte = b[at + i];
    value += (byte & 0x7f) * mul;
    if (!(byte & 0x80)) return { value, size: i + 1 };
    mul *= 128;
  }
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 中身を開く芯。どんな入力でも投げない。
 * - 最後のパケットがフレームの途中で切れていれば、その残りのバイトを rest に返す（次のフレームにつなぐため）
 * - パケットの中の長さが合わない（フレームが前のパケットの途中から始まっている等）ときは malformed を立ててそこで止める
 */
function decodeCore(b: Buffer, version: 4 | 5): { packets: MqttPacket[]; rest: Buffer } {
  const out: MqttPacket[] = [];
  let at = 0;
  while (at < b.length) {
    const first = b[at];
    const type = first >> 4;
    const p: MqttPacket = { type, typeName: MQTT_TYPES[type] || `不明(${type})` };
    if (type === 0) { p.malformed = '種類 0 のパケットは無い（パケットの頭ではないところから読んでいる）'; out.push(p); return { packets: out, rest: Buffer.alloc(0) }; }
    const len = readVarInt(b, at + 1);
    if (!len || at + 1 + len.size + len.value > b.length) {
      p.truncated = true;
      out.push(p);
      return { packets: out, rest: b.subarray(at) };
    }
    const start = at + 1 + len.size;
    const end = start + len.value;
    if (type === 3) {
      p.dup = !!(first & 0x08);
      p.qos = (first >> 1) & 0x03;
      p.retain = !!(first & 0x01);
      let i = start;
      const bad = (why: string) => { p.malformed = why; out.push(p); return { packets: out, rest: Buffer.alloc(0) }; };
      if (i + 2 > end) return bad('topic の長さが読めない');
      const tlen = b.readUInt16BE(i); i += 2;
      if (i + tlen > end) return bad(`topic の長さ（${tlen}）がパケットを超えている`);
      p.topic = b.subarray(i, i + tlen).toString('utf8'); i += tlen;
      if (p.qos > 0) {
        if (i + 2 > end) return bad('パケット番号が読めない');
        p.packetId = b.readUInt16BE(i); i += 2;
      }
      if (version === 5) {
        const pl = readVarInt(b, i);
        if (!pl || i + pl.size + pl.value > end) return bad('properties の長さがパケットを超えている');
        i += pl.size + pl.value;
      }
      const payload = b.subarray(i, end);
      p.payload = payload.toString('base64');
      try {
        p.payloadText = utf8.decode(payload);
        try { p.payloadJson = JSON.parse(p.payloadText); } catch {}
      } catch {}
    }
    out.push(p);
    at = end;
  }
  return { packets: out, rest: Buffer.alloc(0) };
}

const toBuf = (input: string | Uint8Array) => (typeof input === 'string' ? Buffer.from(input, 'base64') : Buffer.from(input));

/** base64 か Buffer で受け取り、入っているパケットを全部返す（どんな入力でも投げない） */
export function decodeMqtt(input: string | Uint8Array, opt: { version?: 4 | 5 } = {}): MqttPacket[] {
  return decodeCore(toBuf(input), opt.version ?? 4).packets;
}

/**
 * フレームをまたぐパケットをつなぎ直して開く。接続（key）ごとに、前のフレームで切れた残りを覚えておく。
 * 残りが maxBytes を超えたら捨てて、捨てたことを dropped に数える（黙って膨らませない）。
 */
export class MqttJoiner {
  #rest = new Map<string, Buffer>();
  dropped = 0;
  readonly maxBytes: number;
  constructor(maxBytes = 4_000_000) { this.maxBytes = maxBytes; }

  feed(key: string, input: string | Uint8Array, opt: { version?: 4 | 5 } = {}): MqttPacket[] {
    const prev = this.#rest.get(key);
    const b = prev ? Buffer.concat([prev, toBuf(input)]) : toBuf(input);
    const { packets, rest } = decodeCore(b, opt.version ?? 4);
    if (rest.length && rest.length <= this.maxBytes) {
      this.#rest.set(key, rest);
      // 最後の切れたものは、次のフレームでつながるので返さない
      return packets.filter((p) => !p.truncated);
    }
    if (rest.length) this.dropped++;
    this.#rest.delete(key);
    return packets;
  }

  /** 接続が閉じたときなどに、その接続の残りを捨てる */
  forget(key: string): void { this.#rest.delete(key); }
}

/** 試験と、拡張の試しのために: PUBLISH を 1 つ組み立てる（QoS 0・版 4） */
export function encodeMqttPublish(topic: string, payload: string | Uint8Array): Buffer {
  const t = Buffer.from(topic, 'utf8');
  const body = Buffer.concat([Buffer.from([t.length >> 8, t.length & 0xff]), t, Buffer.from(payload)]);
  const lenBytes: number[] = [];
  let n = body.length;
  do { let byte = n % 128; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; lenBytes.push(byte); } while (n > 0);
  return Buffer.concat([Buffer.from([0x30, ...lenBytes]), body]);
}
