import { assertEquals } from "@std/assert";
import {
  attestedBudgetConstraint,
  attestRequirementSourceText,
  attestStructuredFilterSourceText,
  requirementNeedsSourceAttestation,
  resolveRequirementSource,
} from "../functions/_shared/requirement_source.ts";

Deno.test("source gate: UIのfilter chipをraw_queryの独立節へattestする", () => {
  const rawQuery =
    "池袋 / 焼肉 / 禁煙 / Wi-Fi / 子連れOK / 徒歩5分以内 / 好み: 肉";
  const cases = [
    ["atmosphere", "禁煙", "禁煙"],
    ["other", "Wi-Fi", "Wi-Fi"],
    ["other", "子連れOK", "子連れOK"],
    ["access", "徒歩5分以内", "徒歩5分以内"],
  ] as const;
  for (const [storedKind, text, normalizedText] of cases) {
    assertEquals(
      resolveRequirementSource({
        storedKind,
        text,
        normalizedText,
        rawQuery,
      }),
      { kind: storedKind, originalText: text, sourceAttested: true },
      text,
    );
  }
});

Deno.test("source gate: 捏造chip・極性変更・同domain複数条件をfail closedにする", () => {
  assertEquals(
    attestStructuredFilterSourceText({
      text: "禁煙",
      normalizedText: "禁煙",
      rawQuery: "池袋 / 焼肉 / Wi-Fi",
    }),
    null,
  );
  assertEquals(
    attestStructuredFilterSourceText({
      text: "喫煙可",
      normalizedText: "禁煙",
      rawQuery: "池袋 / 喫煙可",
    }),
    null,
  );
  assertEquals(
    attestStructuredFilterSourceText({
      text: "徒歩5分以内",
      normalizedText: "徒歩5分以内",
      rawQuery: "池袋 / 徒歩5分以内 / 徒歩10分以内",
    }),
    null,
  );
});

Deno.test("source gate: 認証済みユーザーが直接追加したchipを安全なkindへ分類する", () => {
  assertEquals(
    resolveRequirementSource({
      storedKind: null,
      text: "徒歩5分以内",
      normalizedText: "徒歩5分以内",
      rawQuery: "元の調査条件",
    }),
    {
      kind: "access",
      originalText: "徒歩5分以内",
      sourceAttested: true,
    },
  );
  assertEquals(
    resolveRequirementSource({
      storedKind: null,
      text: "Wi-Fi",
      normalizedText: "Wi-Fiなし",
      rawQuery: "元の調査条件",
    }).sourceAttested,
    false,
  );
});

Deno.test("source gate: frontendと共有するquarantine/semantic vectorsでparser・UI追加を同じ分類にする", async () => {
  const vectors = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../scripts/fixtures/requirement-source-display-vectors.json",
        import.meta.url,
      ),
    ),
  ) as {
    quarantine: string[];
    semantic: string[];
    noConstraintDomains: string[];
    noConstraintForms: string[];
    noConstraintSemanticExceptions: string[];
  };
  for (const storedKind of [null, "other"] as const) {
    for (const text of vectors.quarantine) {
      assertEquals(
        resolveRequirementSource({
          storedKind,
          text,
          normalizedText: text,
          rawQuery: text,
        }).sourceAttested,
        false,
        `${storedKind ?? "null"}: ${text}`,
      );
    }
    for (const text of vectors.semantic) {
      assertEquals(
        resolveRequirementSource({
          storedKind,
          text,
          normalizedText: text,
          rawQuery: text,
        }).sourceAttested,
        true,
        `${storedKind ?? "null"}: ${text}`,
      );
    }
    for (const domain of vectors.noConstraintDomains) {
      for (const form of vectors.noConstraintForms) {
        const text = `${domain}${form}`;
        assertEquals(
          resolveRequirementSource({
            storedKind,
            text,
            normalizedText: text,
            rawQuery: text,
          }).sourceAttested,
          vectors.noConstraintSemanticExceptions.includes(text),
          `${storedKind ?? "null"}: ${text}`,
        );
      }
    }
  }
});

Deno.test("source gate: raw_queryの一意な条件節・text・normalizedTextが同じintentなら原文を採用", () => {
  const rawQuery =
    "8/23に池袋で焼肉。予算３０００円、個室あり、静か、4人、カード払いしたい。朝やってるところ";
  const cases = [
    {
      kind: "budget",
      text: "予算３０００円",
      normalizedText: "予算 3000円前後",
    },
    { kind: "reservation", text: "個室あり", normalizedText: "個室あり" },
    { kind: "party_size", text: "4人", normalizedText: "4人で利用可能" },
    {
      kind: "payment",
      text: "カード払いしたい",
      normalizedText: "クレジットカード利用可能",
    },
    { kind: "time", text: "朝", normalizedText: "朝の時間帯に営業している" },
  ];
  for (const input of cases) {
    assertEquals(
      attestRequirementSourceText({ ...input, rawQuery }),
      input.text,
      input.kind,
    );
  }
});

Deno.test("source gate: 金額の桁区切りcommaはhard clause境界にしない", () => {
  assertEquals(
    attestRequirementSourceText({
      kind: "budget",
      text: "予算3,000円以下",
      normalizedText: "予算3000円以下",
      rawQuery: "池袋で焼肉。予算3,000円以下、カード利用可",
    }),
    "予算3,000円以下",
  );
});

Deno.test("source gate: 場所contextと同値の予算表現を安全にattestする", () => {
  const cases = [
    ["予算3000円まで", "予算3000円以下"],
    ["一人3000円", "予算3000円前後"],
    ["1人3000円", "予算3000円前後"],
    ["予算1万円以下", "予算10000円以下"],
    ["予算1.5万円以下", "予算15000円以下"],
  ] as const;
  for (const [text, normalizedText] of cases) {
    assertEquals(
      attestRequirementSourceText({
        kind: "budget",
        text,
        normalizedText,
        rawQuery: `池袋で${text}`,
      }),
      text,
    );
  }
});

Deno.test("source gate: anchoredな肯定・丁寧表現を原文のままattestする", () => {
  const cases = [
    ["budget", "3000円でお願いします", "3000円前後"],
    ["budget", "3000円くらいがいい", "3000円前後"],
    ["budget", "予算3000円以内が希望", "予算3000円以内"],
    ["party_size", "4人で行きたい", "4人で利用可能"],
    ["party_size", "4人で予約したい", "4人で利用可能"],
    ["payment", "カード利用可がいい", "クレジットカード利用可能"],
    ["reservation", "予約したいです", "予約可能"],
    ["reservation", "個室希望です", "個室あり"],
    ["time", "朝がいい", "朝に営業"],
    ["time", "夜に行きたい", "夜に営業"],
  ] as const;
  for (const [kind, text, normalizedText] of cases) {
    assertEquals(
      attestRequirementSourceText({
        kind,
        text,
        normalizedText,
        rawQuery: text,
      }),
      text,
      text,
    );
  }
});

Deno.test("source gate: parser由来の明示時間範囲をraw_queryへattestする", () => {
  const cases = [
    ["18:00〜20:00", "18時から20時まで"],
    ["22時〜翌2時", "22:00〜翌2:00"],
    ["午前8時から午前10時まで", "08:00〜10:00"],
  ] as const;
  for (const [text, normalizedText] of cases) {
    assertEquals(
      attestRequirementSourceText({
        kind: "time",
        text,
        normalizedText,
        rawQuery: `六本木。${text}`,
      }),
      text,
      text,
    );
    assertEquals(
      resolveRequirementSource({
        storedKind: "time",
        text,
        normalizedText,
        rawQuery: `六本木。${text}`,
      }),
      { kind: "time", originalText: text, sourceAttested: true },
      text,
    );
  }
  // kind=NULL の直接追加でも、同値の明示範囲は決定論的に time へ分類できる。
  assertEquals(
    resolveRequirementSource({
      storedKind: null,
      text: "18:00〜20:00",
      normalizedText: "18時から20時まで",
      rawQuery: "元の調査条件",
    }),
    {
      kind: "time",
      originalText: "18:00〜20:00",
      sourceAttested: true,
    },
  );
});

Deno.test("source gate: 明示時間範囲の否定・選言・単独時刻はattestしない", () => {
  const cases = [
    {
      text: "18時〜20時",
      normalizedText: "18時〜20時",
      rawQuery: "18時〜20時ではない",
    },
    {
      text: "18時〜20時",
      normalizedText: "18時〜20時",
      rawQuery: "18時〜20時、22時〜23時",
    },
    {
      text: "18時から",
      normalizedText: "18時から",
      rawQuery: "18時から",
    },
    {
      text: "18時以降",
      normalizedText: "18時以降",
      rawQuery: "18時以降",
    },
  ];
  for (const input of cases) {
    assertEquals(attestRequirementSourceText({ kind: "time", ...input }), null);
  }
});

Deno.test("source gate: 非deterministic語彙の部分文字列を誤ってattestation必須にしない", () => {
  for (
    const [kind, text] of [
      ["location", "朝霞市"],
      ["atmosphere", "夜景がきれい"],
      ["cuisine", "朝鮮料理"],
      ["cuisine", "ランチコース"],
      ["access", "夜行バスで行ける"],
      ["cuisine", "おまかせコース"],
      ["cuisine", "おまかせ料理"],
      ["atmosphere", "制限なしでゆっくり"],
      ["atmosphere", "時間制限なしでゆっくりできる"],
      ["cuisine", "未定食堂"],
      ["cuisine", "指定なし食堂"],
    ] as const
  ) {
    assertEquals(requirementNeedsSourceAttestation(kind, text, text), false);
  }
  assertEquals(
    requirementNeedsSourceAttestation(
      "other",
      "カードは使いたくない",
      "クレジットカード利用可能",
    ),
    true,
  );
  assertEquals(
    requirementNeedsSourceAttestation(
      "other",
      "クレジットカード利用可能",
      "クレジットカード利用可能",
    ),
    true,
  );
  assertEquals(
    requirementNeedsSourceAttestation(
      "other",
      "クレジットカード利用可能",
      "クレジットカード利用可能",
      true,
    ),
    false,
  );
  for (
    const text of [
      "カード不要",
      "カードは避けたい",
      "現金のみ",
      "予約不要",
      "予約しない",
      "個室不要",
      "個室は利用しない",
      "4人では行かない",
      "4人以上",
      "予算未定",
      "3000円は避けたい",
      "朝は避けたい",
      "夜営業不要",
      "朝営業なし",
      "時間指定なし",
      "時間は問わない",
      "人数未定",
      "参加者未定",
      "メンバー未定",
      "予算不要",
      "金額未定",
      "料金問わない",
      "費用未定",
      "値段未定",
      "単価未定",
      "支払い方法未定",
      "決済手段は問わない",
      "現金もカードも問わない",
      "予約方法未定",
      "席種は問わない",
      "座席指定なし",
      "同行者未定",
      "何人でもよい",
      "グループ構成未定",
      "日程未定",
      "日時指定なし",
      "支払い方法不問",
      "席種不問",
      "同行者不問",
      "日時不問",
      "条件なし",
      "条件は無し",
      "指定しない",
      "何でも可",
      "上限無し",
      "制限なし",
      "予約OK",
    ]
  ) {
    assertEquals(
      requirementNeedsSourceAttestation("other", text, text),
      true,
      text,
    );
  }
});

Deno.test("source gate: 非time語彙を含む別節は有効な時間条件をvetoしない", () => {
  for (
    const rawQuery of [
      "朝霞市で焼肉。夜",
      "朝鮮料理。夜",
      "夜景がきれい。夜",
      "ランチコース。朝",
      "夜行バスで行ける。朝",
    ]
  ) {
    const text = rawQuery.endsWith("夜") ? "夜" : "朝";
    assertEquals(
      attestRequirementSourceText({
        kind: "time",
        text,
        normalizedText: `${text}に営業`,
        rawQuery,
      }),
      text,
      rawQuery,
    );
  }
});

Deno.test("source gate: prefix付きの別time否定・選言節も見落とさない", () => {
  for (
    const rawQuery of [
      "朝。できれば夜は避けたい",
      "朝。店は夜を避けたい",
      "朝。営業時間は夜ではない",
      "朝。候補は夜または昼",
      "朝。私は夜は無理",
      "夜営業は避けたい。夜",
      "夜型は避けたい。夜",
      "朝営業は不要。朝",
      "ランチ営業は除外。ランチ",
      "深夜営業は避けたい。深夜",
      "朝限定は嫌。朝",
    ]
  ) {
    const text = rawQuery.split("。").at(-1)!;
    assertEquals(
      attestRequirementSourceText({
        kind: "time",
        text,
        normalizedText: `${text}に営業`,
        rawQuery,
      }),
      null,
      rawQuery,
    );
  }
});

Deno.test("source gate: 否定・除外・選言・例示は肯定intentとしてattestしない", () => {
  const cases = [
    {
      kind: "budget",
      rawQuery: "3000円以下ではない店",
      text: "3000円",
      normalizedText: "3000円以下",
    },
    {
      kind: "budget",
      rawQuery: "3000円以内を避けたい",
      text: "3000円以内",
      normalizedText: "3000円以内",
    },
    {
      kind: "budget",
      rawQuery: "3000円または5000円",
      text: "3000円",
      normalizedText: "3000円前後",
    },
    {
      kind: "budget",
      rawQuery: "予算を決めない（3000円など）",
      text: "3000円",
      normalizedText: "3000円前後",
    },
    {
      kind: "time",
      rawQuery: "朝は避けたい",
      text: "朝",
      normalizedText: "朝に営業",
    },
    {
      kind: "time",
      rawQuery: "朝以外",
      text: "朝",
      normalizedText: "朝に営業",
    },
    {
      kind: "time",
      rawQuery: "朝食は不要",
      text: "朝食",
      normalizedText: "朝に営業",
    },
    {
      kind: "time",
      rawQuery: "夜ではない",
      text: "夜",
      normalizedText: "夜に営業",
    },
    {
      kind: "time",
      rawQuery: "朝または夜",
      text: "朝",
      normalizedText: "朝に営業",
    },
  ];
  for (const input of cases) {
    assertEquals(attestRequirementSourceText(input), null, input.rawQuery);
  }
});

Deno.test("source gate: invented text・重複箇所・同kindの複数intentはfail-closed", () => {
  assertEquals(
    attestRequirementSourceText({
      kind: "payment",
      text: "カード利用可",
      normalizedText: "クレジットカード利用可能",
      rawQuery: "現金だけで払いたい",
    }),
    null,
  );
  assertEquals(
    attestRequirementSourceText({
      kind: "time",
      text: "朝",
      normalizedText: "朝に営業",
      rawQuery: "朝、朝",
    }),
    null,
  );
  assertEquals(
    attestRequirementSourceText({
      kind: "budget",
      text: "予算3000円",
      normalizedText: "予算3000円前後",
      rawQuery: "予算3000円、別案は予算5000円",
    }),
    null,
  );
  for (
    const input of [
      {
        kind: "payment",
        text: "カード可",
        normalizedText: "クレジットカード利用可能",
        rawQuery: "カード可。カードは使いたくない",
      },
      {
        kind: "budget",
        text: "3000円以下",
        normalizedText: "3000円以下",
        rawQuery: "3000円以下。5000円は避けたい",
      },
      {
        kind: "time",
        text: "朝",
        normalizedText: "朝に営業",
        rawQuery: "朝。夜は避けたい",
      },
    ]
  ) assertEquals(attestRequirementSourceText(input), null, input.rawQuery);
});

Deno.test("source gate: 予約可と個室ありは別subjectとして各々attestする", () => {
  const rawQuery = "予約可。個室あり";
  assertEquals(
    attestRequirementSourceText({
      kind: "reservation",
      text: "予約可",
      normalizedText: "予約可能",
      rawQuery,
    }),
    "予約可",
  );
  assertEquals(
    attestRequirementSourceText({
      kind: "reservation",
      text: "個室あり",
      normalizedText: "個室あり",
      rawQuery,
    }),
    "個室あり",
  );
  assertEquals(
    attestRequirementSourceText({
      kind: "reservation",
      text: "予約可",
      normalizedText: "予約可能",
      rawQuery: "予約可。予約不可",
    }),
    null,
  );
});

Deno.test("source gate: 同domainの制約なし節を捨てて後続の肯定だけを採用しない", () => {
  for (
    const input of [
      {
        kind: "budget",
        rawQuery: "費用未定。3000円以下",
        text: "3000円以下",
        normalizedText: "予算3000円以下",
      },
      {
        kind: "budget",
        rawQuery: "上限なし。3000円以下",
        text: "3000円以下",
        normalizedText: "予算3000円以下",
      },
      {
        kind: "payment",
        rawQuery: "支払い方法未定。カード可",
        text: "カード可",
        normalizedText: "クレジットカード利用可能",
      },
      {
        kind: "reservation",
        rawQuery: "席種は問わない。個室あり",
        text: "個室あり",
        normalizedText: "個室あり",
      },
      {
        kind: "party_size",
        rawQuery: "同行者未定。4人",
        text: "4人",
        normalizedText: "4人で利用可能",
      },
      {
        kind: "time",
        rawQuery: "日時指定なし。朝",
        text: "朝",
        normalizedText: "朝に営業",
      },
      {
        kind: "payment",
        rawQuery: "支払い方法不問。カード可",
        text: "カード可",
        normalizedText: "クレジットカード利用可能",
      },
      {
        kind: "reservation",
        rawQuery: "席種不問。個室あり",
        text: "個室あり",
        normalizedText: "個室あり",
      },
      {
        kind: "party_size",
        rawQuery: "同行者不問。4人",
        text: "4人",
        normalizedText: "4人で利用可能",
      },
      {
        kind: "time",
        rawQuery: "日時不問。朝",
        text: "朝",
        normalizedText: "朝に営業",
      },
      {
        kind: "payment",
        rawQuery: "条件なし。カード可",
        text: "カード可",
        normalizedText: "クレジットカード利用可能",
      },
      {
        kind: "payment",
        rawQuery: "おまかせ。カード可",
        text: "カード可",
        normalizedText: "クレジットカード利用可能",
      },
      {
        kind: "payment",
        rawQuery: "指定なし。カード可",
        text: "カード可",
        normalizedText: "クレジットカード利用可能",
      },
      {
        kind: "payment",
        rawQuery: "何でもよい。カード可",
        text: "カード可",
        normalizedText: "クレジットカード利用可能",
      },
      {
        kind: "party_size",
        rawQuery: "上限なし。4人",
        text: "4人",
        normalizedText: "4人で利用可能",
      },
      {
        kind: "time",
        rawQuery: "制限なし。朝",
        text: "朝",
        normalizedText: "朝に営業",
      },
    ]
  ) {
    assertEquals(attestRequirementSourceText(input), null, input.rawQuery);
  }
});

Deno.test("source gate: tokenを含むだけの逆極性・比較・不足表現をattestしない", () => {
  const cases = [
    ["reservation", "予約しない", "予約", "予約可能"],
    ["reservation", "個室は利用しない", "個室", "個室あり"],
    ["reservation", "予約はしません", "予約", "予約可能"],
    ["budget", "3000円は安すぎる", "3000円", "3000円前後"],
    ["budget", "3000円より高い店がいい", "3000円", "3000円前後"],
    ["budget", "予算3000円にはしない", "予算3000円", "予算3000円前後"],
    ["budget", "3000円では足りない", "3000円", "3000円前後"],
    ["time", "朝は無理", "朝", "朝に営業"],
    ["time", "朝には行かない", "朝", "朝に営業"],
    ["time", "朝は早すぎる", "朝", "朝に営業"],
    ["time", "夜遅くは困る", "夜", "夜に営業"],
    ["party_size", "4人は多すぎる", "4人", "4人で利用可能"],
    ["party_size", "4人では行かない", "4人", "4人で利用可能"],
    ["party_size", "4人より多い", "4人", "4人で利用可能"],
    ["party_size", "4人未満", "4人", "4人で利用可能"],
    ["party_size", "4人じゃ足りない", "4人", "4人で利用可能"],
    ["party_size", "メンバー未定で4人", "4人", "4人で利用可能"],
    ["party_size", "メンバーは決めないで4人", "4人", "4人で利用可能"],
    ["party_size", "参加者は問わないで4人", "4人", "4人で利用可能"],
    ["payment", "カードしか使えない", "カード", "クレジットカード利用可能"],
    ["budget", "予算を決めないので3000円", "3000円", "3000円前後"],
    ["budget", "予算不要で3000円", "3000円", "3000円前後"],
    ["budget", "金額は問わないので3000円", "3000円", "3000円前後"],
    ["budget", "上限なしで3000円", "3000円", "3000円前後"],
    ["budget", "制限なしで3000円", "3000円", "3000円前後"],
    ["party_size", "上限なしで4人", "4人", "4人で利用可能"],
    ["time", "時間指定なしで朝", "朝", "朝に営業"],
    ["payment", "指定なしでカード可", "カード可", "クレジットカード利用可能"],
  ] as const;
  for (const [kind, rawQuery, text, normalizedText] of cases) {
    assertEquals(
      attestRequirementSourceText({ kind, rawQuery, text, normalizedText }),
      null,
      rawQuery,
    );
  }
});

Deno.test("source gate: create検索予算はsourceとnormalizedが一致する一意な肯定条件だけ", () => {
  assertEquals(
    attestedBudgetConstraint({
      kind: "budget",
      text: "予算３０００円",
      normalizedText: "予算 3000円前後",
      rawQuery: "新宿で焼肉。予算３０００円",
    }),
    { maxYen: 3000, toleranceYen: 600 },
  );
  assertEquals(
    attestedBudgetConstraint({
      kind: "budget",
      text: "3000円以下",
      normalizedText: "3000円以下",
      rawQuery: "3000円以下ではない",
    }),
    null,
  );
  assertEquals(
    attestedBudgetConstraint({
      kind: "budget",
      text: "3000円",
      normalizedText: "3000円前後",
      rawQuery: "3000円、5000円",
    }),
    null,
  );
});

Deno.test("source gate: range / max / aroundのoperatorを同じ上限額へ潰さない", () => {
  assertEquals(
    attestRequirementSourceText({
      kind: "budget",
      text: "予算3000〜5000円",
      normalizedText: "予算5000円以下",
      rawQuery: "予算3000〜5000円",
    }),
    null,
  );
  assertEquals(
    attestRequirementSourceText({
      kind: "budget",
      text: "予算3000〜5000円",
      normalizedText: "予算3000〜5000円",
      rawQuery: "予算3000〜5000円",
    }),
    "予算3000〜5000円",
  );
});

Deno.test("source gate: 英語の円上限を同値の日本語正規化へattestする (issue #514)", () => {
  assertEquals(
    resolveRequirementSource({
      storedKind: "budget",
      text: "under ¥4,000",
      normalizedText: "4000円以下",
      rawQuery: "Yakiniku, under ¥4,000, Ikebukuro",
    }),
    {
      kind: "budget",
      originalText: "under ¥4,000",
      sourceAttested: true,
    },
  );
});
