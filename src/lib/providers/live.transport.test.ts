import { describe, expect, it } from 'vitest';

import { readLiveAPIResponseText } from './live';

describe('live API transport boundary', () => {
  it('reads chunked UTF-8 responses without replacing bytes', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"'));
        controller.enqueue(new TextEncoder().encode('recalling"}'));
        controller.close();
      },
    });
    await expect(readLiveAPIResponseText(new Response(body))).resolves.toBe(
      '{"status":"recalling"}',
    );
  });

  it('rejects invalid UTF-8 and oversized responses before parsing', async () => {
    await expect(
      readLiveAPIResponseText(new Response(new Uint8Array([0x7b, 0xff, 0x7d]))),
    ).rejects.toThrow('API応答を解釈できません');

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(17));
        controller.close();
      },
    });
    await expect(readLiveAPIResponseText(new Response(body), 16)).rejects.toThrow(
      'API応答が大きすぎます',
    );
  });

  it('rejects missing streams and dishonest content-length', async () => {
    await expect(
      readLiveAPIResponseText(
        new Response('{}', { headers: { 'content-length': '999' } }),
        16,
      ),
    ).rejects.toThrow('API応答のサイズが不正です');
    await expect(
      readLiveAPIResponseText(new Response(null), 16),
    ).rejects.toThrow('API応答ストリームを利用できません');
  });
});
