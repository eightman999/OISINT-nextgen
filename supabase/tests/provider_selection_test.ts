// live provider の切替境界 (#530 / #297)。
// HotPepper の credential が環境に残っていても live/fallback の選択へ影響しないこと、
// 新しい live discovery provider を API key なしの factory 段階で確認する。
import { assertEquals, assertThrows } from "@std/assert";
import {
  getProviders,
  livePlaceProvider,
} from "../functions/_shared/providers/index.ts";

function withEnv(vars: Record<string, string | null>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = Deno.env.get(key);
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("live factory: HOTPEPPER_API_KEYなしでも既定のGeoapifyを選ぶ", () => {
  withEnv({
    DATA_PROVIDER_MODE: "live",
    PLACE_PROVIDER: null,
    GEOAPIFY_API_KEY: null,
    HOTPEPPER_API_KEY: null,
  }, () => {
    const provider = livePlaceProvider();
    assertEquals(provider.meta.id, "geoapify");
    assertEquals(provider.meta.storagePolicy, "persistent");
    assertEquals(provider.meta.attributionPolicy, "osm_odbl_attribution");
    assertEquals(getProviders().place.meta.id, "geoapify");
  });
});

Deno.test("live factory: retired HotPepper provider nameはfallbackされずfail-closed", () => {
  withEnv({ DATA_PROVIDER_MODE: "live", PLACE_PROVIDER: "hotpepper" }, () => {
    assertThrows(() => livePlaceProvider(), Error, "未知の PLACE_PROVIDER");
  });
});

Deno.test("mock factory: 外部API keyなしでもHotPepperへ戻らずmockを選ぶ", () => {
  withEnv({
    DATA_PROVIDER_MODE: "mock",
    PLACE_PROVIDER: "hotpepper",
    HOTPEPPER_API_KEY: null,
    GEOAPIFY_API_KEY: null,
  }, () => {
    assertEquals(getProviders().place.meta.id, "mock");
  });
});
