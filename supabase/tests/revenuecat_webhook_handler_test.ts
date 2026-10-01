import { assert, assertEquals } from "@std/assert";
import { createRevenueCatWebhookSignature } from "../functions/_shared/revenuecat.ts";

// 実entrypointを登録するがlistenはせず、HTTP→署名検証→RPC引数までを実行する。
// env/fetchは全てfixtureへ閉じ、DB・RevenueCatへの実通信を許可しない。
Deno.test("Google通知は署名検証後に正規商品IDをRPCへ渡し、lifecycle照合も行う", async (t) => {
  const originalServe = Deno.serve;
  const originalEnvGet = Deno.env.get;
  const originalFetch = globalThis.fetch;
  let handler: ((req: Request) => Promise<Response>) | undefined;
  const environment: Record<string, string> = {
    SUPABASE_URL: "https://fixture.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-role",
    REVENUECAT_WEBHOOK_TOKEN: "t".repeat(32),
    REVENUECAT_WEBHOOK_HMAC_SECRET: "h".repeat(32),
    REVENUECAT_SECRET_API_KEY: "s".repeat(32),
    REVENUECAT_APP_ID: "fixture-ios, fixture-app",
    REVENUECAT_ALLOWED_ENVIRONMENTS: "SANDBOX",
  };
  const subject = "00000000-0000-4000-8000-000000000571";
  const expiresAt = Date.now() + 86_400_000;
  const calls: Array<Record<string, unknown>> = [];
  let subscriberCalls = 0;
  try {
    Reflect.set(Deno, "serve", (callback: typeof handler) => {
      handler = callback;
    });
    Reflect.set(Deno.env, "get", (name: string) => environment[name]);
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url === `https://api.revenuecat.com/v1/subscribers/${subject}`
      ) {
        subscriberCalls += 1;
        return Response.json({
          subscriber: {
            entitlements: {
              plus: {
                product_identifier: "oisint_plus_monthly:monthly2",
                expires_date: new Date(expiresAt).toISOString(),
                is_sandbox: true,
              },
            },
            subscriptions: {
              "oisint_plus_monthly:monthly2": {
                store: "play_store",
                is_sandbox: true,
                auto_renewing: false,
              },
            },
          },
        });
      }
      assertEquals(
        request.url,
        "https://fixture.supabase.co/rest/v1/rpc/apply_revenuecat_webhook_event",
      );
      assertEquals(request.method, "POST");
      const args = await request.json();
      calls.push(args);
      // DBを代用する固定応答。DBの制約ではなく、ここへ渡す引数を検証する。
      return Response.json("applied");
    };
    await import("../functions/revenuecat-webhook/index.ts");
    assert(handler);
    const invoke = handler;
    const send = async (
      type: string,
      product: string,
      newProduct?: string,
      signed = true,
    ) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const rawBody = JSON.stringify({
        api_version: "1.0",
        event: {
          id: crypto.randomUUID(),
          type,
          event_timestamp_ms: Date.now(),
          app_id: "fixture-app",
          app_user_id: subject,
          entitlement_ids: ["plus"],
          product_id: product,
          new_product_id: newProduct,
          store: "PLAY_STORE",
          environment: "SANDBOX",
          expiration_at_ms: expiresAt,
        },
      });
      const signature = await createRevenueCatWebhookSignature(
        environment.REVENUECAT_WEBHOOK_HMAC_SECRET,
        timestamp,
        rawBody,
      );
      return await invoke(
        new Request("https://edge.example/revenuecat-webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${environment.REVENUECAT_WEBHOOK_TOKEN}`,
            "X-RevenueCat-Webhook-Signature": `t=${timestamp},v1=${
              signed ? signature : "0".repeat(64)
            }`,
          },
          body: rawBody,
        }),
      );
    };

    await t.step(
      "購入・更新・失効のRPCにはcanonical IDだけを渡す",
      async () => {
        for (
          const [type, product, expected] of [
            [
              "INITIAL_PURCHASE",
              "oisint_plus_monthly:monthly2",
              "oisint_plus_monthly",
            ],
            ["RENEWAL", "oisint_plus_annual:2annual", "oisint_plus_annual"],
            [
              "EXPIRATION",
              "oisint_plus_monthly:monthly2",
              "oisint_plus_monthly",
            ],
          ]
        ) {
          assertEquals((await send(type, product)).status, 200);
          assertEquals(calls.at(-1)?.p_product_id, expected);
          assertEquals(calls.at(-1)?.p_event_type, type);
        }
        assertEquals(subscriberCalls, 0);
      },
    );

    await t.step(
      "解約・変更はSubscriberのcurrent stateを照合する",
      async () => {
        assertEquals(
          (await send("CANCELLATION", "oisint_plus_monthly:monthly2")).status,
          200,
        );
        assertEquals(subscriberCalls, 1);
        assertEquals(calls.at(-1)?.p_product_id, "oisint_plus_monthly");
        assertEquals(calls.at(-1)?.p_expiration_at_ms, expiresAt);
        assertEquals(
          (await send(
            "PRODUCT_CHANGE",
            "oisint_plus_monthly:monthly2",
            "oisint_plus_annual:2annual",
          )).status,
          200,
        );
        assertEquals(subscriberCalls, 2);
        // 期末の年額変更通知でも、現在有効な月額をSubscriberから採用する。
        assertEquals(calls.at(-1)?.p_product_id, "oisint_plus_monthly");
      },
    );

    await t.step("未知IDをnullへ変換せずDBの拒否判定へ渡す", async () => {
      assertEquals(
        (await send("CANCELLATION", "oisint_plus_monthly:unknown")).status,
        200,
      );
      assertEquals(calls.at(-1)?.p_product_id, "oisint_plus_monthly:unknown");
      assertEquals(subscriberCalls, 2);
    });

    await t.step("既知Google IDでも署名不正ならRPCへ到達しない", async () => {
      const previousCalls = calls.length;
      assertEquals(
        (await send(
          "INITIAL_PURCHASE",
          "oisint_plus_monthly:monthly2",
          undefined,
          false,
        )).status,
        401,
      );
      assertEquals(calls.length, previousCalls);
    });
  } finally {
    Reflect.set(Deno, "serve", originalServe);
    Reflect.set(Deno.env, "get", originalEnvGet);
    globalThis.fetch = originalFetch;
  }
});
