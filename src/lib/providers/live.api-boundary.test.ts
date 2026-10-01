import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_TIMEOUT_POLICY,
  EDGE_TIMEOUT_CONTRACT,
  liveProvider,
  WORKER_TIMEOUT_CONTRACT,
} from "./live";
import { CreateIdempotencyState } from "../createIdempotencyState";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getSession: vi.fn(),
}));

const AUTH_SUBJECT = "00000000-0000-4000-8000-000000000571";
const jwtFor = (subject: string) => {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${payload}.signature`;
};

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      signInAnonymously: vi.fn(),
    },
  },
}));

describe("live API credentialed request boundary", () => {
  it("timeoutはEdgeよりWorker、Workerよりclientを長く保つ", () => {
    for (const policy of [
      "receipt",
      "synchronousCreate",
      "synchronousRerank",
    ] as const) {
      expect(EDGE_TIMEOUT_CONTRACT[policy]).toBeLessThan(
        WORKER_TIMEOUT_CONTRACT[policy],
      );
      expect(WORKER_TIMEOUT_CONTRACT[policy]).toBeLessThan(
        API_TIMEOUT_POLICY[policy],
      );
    }
    expect(API_TIMEOUT_POLICY.synchronousCreate).toBeGreaterThanOrEqual(
      API_TIMEOUT_POLICY.receipt,
    );
    expect(API_TIMEOUT_POLICY.synchronousRerank).toBeGreaterThan(
      API_TIMEOUT_POLICY.receipt,
    );
  });

  beforeEach(() => {
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: AUTH_SUBJECT },
          access_token: jwtFor(AUTH_SUBJECT),
        },
      },
    });
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses redirect:error, an abort signal, and strict response keys", async () => {
    mocks.fetch.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          `Bearer ${jwtFor(AUTH_SUBJECT)}`,
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              investigationId: "00000000-0000-4000-8000-000000000572",
              shareToken: "0123456789abcdef0123456789abcdef",
            }),
          ),
        );
      },
    );

    await expect(
      liveProvider.createInvestigation({
        query: "池袋",
        displayName: "利用者",
        idempotencyKey: "create-boundary-key",
        authSubject: AUTH_SUBJECT,
      }),
    ).resolves.toMatchObject({
      investigationId: "00000000-0000-4000-8000-000000000572",
    });
  });

  it("同期createは5秒を超えてもcreate policy内ならabortせず、keyをheaderへ送る", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_input: RequestInfo | URL) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    investigationId: "00000000-0000-4000-8000-000000000572",
                    shareToken: "0123456789abcdef0123456789abcdef",
                  }),
                ),
              ),
            6_000,
          );
        }),
    );

    const pending = liveProvider.createInvestigation({
      query: "池袋",
      displayName: "利用者",
      idempotencyKey: "create-boundary-key",
      authSubject: AUTH_SUBJECT,
    });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toMatchObject({
      investigationId: "00000000-0000-4000-8000-000000000572",
    });
    const [, init] = mocks.fetch.mock.calls[0] as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "create-boundary-key",
    );
    expect(API_TIMEOUT_POLICY.synchronousCreate).toBeGreaterThan(6_000);
  });

  it("旧subject keyで新JWTを送らず、subject切替時はfail closedする", async () => {
    const subjectA = "00000000-0000-4000-8000-000000000571";
    const subjectB = "00000000-0000-4000-8000-000000000572";
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: subjectB },
          access_token: jwtFor(subjectB),
        },
      },
    });

    await expect(
      liveProvider.createInvestigation({
        query: "池袋",
        displayName: "利用者",
        idempotencyKey: "old-subject-key",
        authSubject: subjectA,
      }),
    ).rejects.toThrow("認証状態が切り替わったため");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("実create境界で同一subjectのretry key再利用・切替後の新key・成功clearを検証する", async () => {
    const subjectA = "00000000-0000-4000-8000-000000000571";
    const subjectB = "00000000-0000-4000-8000-000000000572";
    const state = new CreateIdempotencyState(
      vi.fn()
        .mockReturnValueOnce("subject-a-key")
        .mockReturnValueOnce("subject-b-key")
        .mockReturnValueOnce("subject-b-after-success-key"),
    );
    mocks.fetch.mockImplementationOnce(() => Promise.reject(new Error("timeout")));
    mocks.fetch.mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            investigationId: "00000000-0000-4000-8000-000000000572",
            shareToken: "0123456789abcdef0123456789abcdef",
          }),
        ),
    );
    mocks.getSession.mockResolvedValue({
      data: { session: { user: { id: subjectA }, access_token: jwtFor(subjectA) } },
    });

    const firstKey = state.keyFor(subjectA, "same-input");
    await expect(
      liveProvider.createInvestigation({
        query: "池袋",
        displayName: "利用者",
        idempotencyKey: firstKey,
        authSubject: subjectA,
      }),
    ).rejects.toThrow();
    // signed_out→匿名bootstrap等でUI generationが変わっても、同一JWT subjectのretryは同じkey。
    const retryKey = state.keyFor(subjectA, "same-input");
    expect(retryKey).toBe(firstKey);
    await liveProvider.createInvestigation({
      query: "池袋",
      displayName: "利用者",
      idempotencyKey: retryKey,
      authSubject: subjectA,
    });

    mocks.getSession.mockResolvedValue({
      data: { session: { user: { id: subjectB }, access_token: jwtFor(subjectB) } },
    });
    await expect(
      liveProvider.createInvestigation({
        query: "池袋",
        displayName: "利用者",
        idempotencyKey: firstKey,
        authSubject: subjectA,
      }),
    ).rejects.toThrow("認証状態が切り替わったため");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    const newKey = state.keyFor(subjectB, "same-input");
    expect(newKey).not.toBe(firstKey);
    // 旧subjectのcreate responseが遅れて返っても、新subject retryのkeyを消さない。
    expect(state.clearIfMatches(subjectA, "same-input", firstKey)).toBe(false);
    expect(state.keyFor(subjectB, "same-input")).toBe(newKey);
    await liveProvider.createInvestigation({
      query: "池袋",
      displayName: "利用者",
      idempotencyKey: newKey,
      authSubject: subjectB,
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(state.clearIfMatches(subjectB, "same-input", newKey)).toBe(true);
    expect(state.keyFor(subjectB, "same-input")).toBe(
      "subject-b-after-success-key",
    );
  });

  it("research receiptは短いpolicyでabortする", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const pending = liveProvider.runInvestigation({
      investigationId: "00000000-0000-4000-8000-000000000572",
    });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const rejection = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(API_TIMEOUT_POLICY.receipt);
    await rejection;
  });

  it("requirement_added rerankはcreate相当の長いpolicyで5秒超を待つ", async () => {
    vi.useFakeTimers();
    mocks.fetch.mockImplementation(
      (_input: RequestInfo | URL) =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(new Response(JSON.stringify({ reranked: true }))),
            6_000,
          );
        }),
    );

    const pending = liveProvider.rerankInvestigation({
      investigationId: "00000000-0000-4000-8000-000000000572",
      trigger: "requirement_added",
    });
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toEqual({ reranked: true });
    expect(API_TIMEOUT_POLICY.synchronousRerank).toBeGreaterThan(6_000);
  });

  it('rejects unknown response fields before a caller can use them', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      investigationId: '00000000-0000-4000-8000-000000000572',
      shareToken: '0123456789abcdef0123456789abcdef',
      unexpected: 'credential-leak',
    })));

    await expect(
      liveProvider.createInvestigation({
        query: '池袋',
        displayName: '利用者',
        idempotencyKey: 'unknown-response-key',
        authSubject: AUTH_SUBJECT,
      }),
    ).rejects.toThrow();
  });
});
