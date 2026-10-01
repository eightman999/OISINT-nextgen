-- 20260816044234: generated restaurant image catalog
--
-- Provider-owned photos remain URL references in places.metadata.photoUrl. This
-- catalog stores only stable bundled-asset keys and public-safe provenance; no
-- image binary or generated illustration is Evidence.

create table public.restaurant_image_catalog (
  image_key text primary key
    check (image_key ~ '^demo-[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*[.]jpg$'),
  genre_aliases text[] not null default '{}',
  exact_genre_aliases text[] not null default '{}',
  genre_priority smallint not null unique check (genre_priority > 0),
  fallback_slot smallint not null unique check (fallback_slot > 0),
  active boolean not null default true,
  content_sha256 text not null unique
    check (content_sha256 ~ '^[0-9a-f]{64}$'),
  provenance jsonb not null
    check (
      jsonb_typeof(provenance) = 'object'
      and provenance ?& array['sourceKind', 'issueUrl', 'assetPath']
      and provenance ->> 'sourceKind' = 'ai_generated'
      and provenance ->> 'issueUrl' ~ '^https://'
      and provenance ->> 'assetPath' = 'assets/demo/restaurants/' || image_key
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(genre_aliases) + cardinality(exact_genre_aliases) > 0),
  check (not (genre_aliases && exact_genre_aliases))
);

create trigger trg_restaurant_image_catalog_updated_at
before update on public.restaurant_image_catalog
for each row execute function public.set_updated_at();

alter table public.places
  add column fallback_image_key text,
  add constraint places_fallback_image_key_fkey
    foreign key (fallback_image_key)
    references public.restaurant_image_catalog(image_key)
    on update restrict
    on delete restrict;

create index idx_places_fallback_image_key
  on public.places (fallback_image_key)
  where fallback_image_key is not null;

comment on table public.restaurant_image_catalog is
  'Bundled generated restaurant illustrations. Keys are references; image bytes stay in the app bundle.';
comment on column public.places.fallback_image_key is
  'Optional generated illustration override. A valid HTTPS provider photo still takes precedence.';

alter table public.restaurant_image_catalog enable row level security;

revoke all on table public.restaurant_image_catalog from public, anon, authenticated;
grant select (
  image_key,
  active
) on table public.restaurant_image_catalog to authenticated;
grant all on table public.restaurant_image_catalog to service_role;

create policy restaurant_image_catalog_select_active
  on public.restaurant_image_catalog
  for select
  to authenticated
  using (active);

-- Keep this seed semantically equivalent to
-- assets/demo/restaurants/catalog.json. The local migration harness enforces it.
with catalog_entries as (
  select *
  from jsonb_to_recordset((
$restaurant_image_catalog$
{
  "schemaVersion": 1,
  "assetFormat": {
    "mimeType": "image/jpeg",
    "width": 1280,
    "height": 720
  },
  "items": [
  {
    "key": "demo-yakiniku-v1.jpg",
    "aliases": ["焼肉", "焼き肉", "ホルモン", "バーベキュー", "bbq"],
    "exactAliases": [],
    "genrePriority": 1,
    "fallbackSlot": 1,
    "active": true,
    "contentSha256": "e8bd3c69494cc02cc6ecda8746b5782244fc3ea300246bdfdb33c18eed0e331f",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-yakiniku-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-izakaya-v1.jpg",
    "aliases": ["居酒屋", "大衆酒場", "酒場", "ダイニングバー"],
    "exactAliases": [],
    "genrePriority": 19,
    "fallbackSlot": 2,
    "active": true,
    "contentSha256": "1e6cd22652ba5de61e3a1843d524e9a87a685d142dc189e5f97b4689b8206c57",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-izakaya-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-steak-v1.jpg",
    "aliases": ["ステーキ", "鉄板焼き", "鉄板焼", "ハンバーグ", "グリル"],
    "exactAliases": [],
    "genrePriority": 3,
    "fallbackSlot": 3,
    "active": true,
    "contentSha256": "dec74ce7b08b3e656b289c45f73e6aa27b169523a44ffe6b3ac475755384ec88",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-steak-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-sushi-v1.jpg",
    "aliases": ["寿司", "鮨", "すし"],
    "exactAliases": [],
    "genrePriority": 4,
    "fallbackSlot": 4,
    "active": true,
    "contentSha256": "0f378a5f0ba35ec481b5da2a2dfaf27d4044e4441fbd1011131f4096480ef105",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-sushi-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-cafe-v1.jpg",
    "aliases": ["フレンチトースト", "パンケーキ", "カフェ", "喫茶店", "喫茶", "珈琲", "コーヒー", "スイーツ"],
    "exactAliases": [],
    "genrePriority": 6,
    "fallbackSlot": 5,
    "active": true,
    "contentSha256": "3862878594501a14455941474a5cb95129f2c947d294471404a5f45b2ebf44ed",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-cafe-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-ramen-v1.jpg",
    "aliases": ["台湾まぜそば", "中華そば", "まぜそば", "油そば", "ラーメン", "らーめん", "拉麺", "つけ麺", "担々麺", "担担麺"],
    "exactAliases": [],
    "genrePriority": 8,
    "fallbackSlot": 6,
    "active": true,
    "contentSha256": "a0934cf890fa669669a5a190ab4e3b878d43991de075efee5d3f5395306ce12b",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-ramen-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-italian-v1.jpg",
    "aliases": ["イタリアンバル", "イタリア料理", "イタリアン", "ピッツァ", "ピザ", "パスタ"],
    "exactAliases": [],
    "genrePriority": 13,
    "fallbackSlot": 7,
    "active": true,
    "contentSha256": "a7c53a316bd302f88d826e2afdd9bb25c91bcfc71d013b8a632308deaab1ffc7",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-italian-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-washoku-v1.jpg",
    "aliases": ["日本料理", "和食", "懐石", "会席", "割烹", "定食"],
    "exactAliases": [],
    "genrePriority": 18,
    "fallbackSlot": 8,
    "active": true,
    "contentSha256": "071b994c202257b6c8954e689fa537e287168d8881eb87452bb457230a958d6e",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-washoku-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-chinese-v1.jpg",
    "aliases": ["中国料理", "台湾料理", "中華料理", "四川料理", "広東料理", "町中華", "中華", "餃子"],
    "exactAliases": [],
    "genrePriority": 14,
    "fallbackSlot": 9,
    "active": true,
    "contentSha256": "1c48da853d0710b2b2df7f5119d1dfb27daa7570b84f97f3d8f440312d2dfc11",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-chinese-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-bistro-v1.jpg",
    "aliases": ["フランス料理", "ビストロ", "フレンチ", "洋食", "バル"],
    "exactAliases": [],
    "genrePriority": 20,
    "fallbackSlot": 10,
    "active": true,
    "contentSha256": "09385c6c810ff79ac6fc8be4940dd78e441de0ca38d8bf431c9acb4ea1983c04",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-bistro-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-yakitori-v1.jpg",
    "aliases": ["焼き鳥", "焼鳥", "串焼き", "串焼"],
    "exactAliases": [],
    "genrePriority": 2,
    "fallbackSlot": 11,
    "active": true,
    "contentSha256": "99c87d028a9cc1ad54befe460b0334ea6fe2f0dec265050acefcc0a653527c1b",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-yakitori-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-tempura-v1.jpg",
    "aliases": ["天ぷら", "天麩羅", "天婦羅"],
    "exactAliases": [],
    "genrePriority": 11,
    "fallbackSlot": 12,
    "active": true,
    "contentSha256": "2971c7f72a76dc3e26456cf9d4b6999de88acf1f9bb4c5a351f7904452f77e0a",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-tempura-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-soba-v1.jpg",
    "aliases": ["蕎麦", "そば"],
    "exactAliases": [],
    "genrePriority": 9,
    "fallbackSlot": 13,
    "active": true,
    "contentSha256": "25ff5c2c9cf6b38c52881093fa6975bc86b6aa5370e67e6a7aaf9b689f8e0572",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-soba-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-udon-v1.jpg",
    "aliases": ["うどん", "饂飩"],
    "exactAliases": [],
    "genrePriority": 10,
    "fallbackSlot": 14,
    "active": true,
    "contentSha256": "3064863e00c04ae143568030130457077d15404bbeb50655ee9f35b39cfe7351",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-udon-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-curry-v1.jpg",
    "aliases": ["スープカレー", "カレーライス", "カレー", "カリー"],
    "exactAliases": [],
    "genrePriority": 12,
    "fallbackSlot": 15,
    "active": true,
    "contentSha256": "0ffcd0493a114bed08855deb641a212e750c6666133459c270f43cf86cba7b13",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-curry-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-korean-v1.jpg",
    "aliases": ["韓国料理", "韓国家庭料理", "韓国", "コリアン"],
    "exactAliases": [],
    "genrePriority": 15,
    "fallbackSlot": 16,
    "active": true,
    "contentSha256": "4ddcc2b33657dea978f055e4766e67db207ac4f0b573b78d115b44643d56b485",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-korean-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-spanish-v1.jpg",
    "aliases": ["スペイン料理", "スペインバル", "スペイン", "スパニッシュ", "パエリア", "タパス"],
    "exactAliases": [],
    "genrePriority": 16,
    "fallbackSlot": 17,
    "active": true,
    "contentSha256": "626a673e51231b5ab8abfe597087e353cb37137e7b84c00d4ab38ff51fa1302c",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-spanish-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-seafood-v1.jpg",
    "aliases": ["シーフード", "海鮮料理", "魚介料理", "海鮮", "魚介", "刺身"],
    "exactAliases": [],
    "genrePriority": 17,
    "fallbackSlot": 18,
    "active": true,
    "contentSha256": "632c72998cb49286585e835b2815dbe627da28f82392af2b5d9e1752574b92e4",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-seafood-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-vegan-v1.jpg",
    "aliases": ["プラントベース", "ヴィーガン", "ビーガン", "ベジタリアン", "野菜料理"],
    "exactAliases": [],
    "genrePriority": 5,
    "fallbackSlot": 19,
    "active": true,
    "contentSha256": "6da8c49f7bc5a98f1434e00fe25a5ebdd7c1e8c746a72f7c07e42a97c54496d8",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-vegan-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  },
  {
    "key": "demo-bakery-v1.jpg",
    "aliases": ["ブーランジェリー", "ベーカリー", "パン専門店", "パン専門", "パン屋", "パン店", "カレーパン", "食パン", "菓子パン", "惣菜パン"],
    "exactAliases": ["パン"],
    "genrePriority": 7,
    "fallbackSlot": 20,
    "active": true,
    "contentSha256": "39206320dbb574ede2e4c468cf514c0e37c255923ccd251c8040a2fd9aceee70",
    "provenance": {
      "sourceKind": "ai_generated",
      "issueUrl": "https://github.com/eightman999/OISINT/issues/342",
      "assetPath": "assets/demo/restaurants/demo-bakery-v1.jpg",
      "recordedDate": "2026-08-16"
    }
  }
  ]
}
$restaurant_image_catalog$::jsonb) -> 'items'
  ) as entry(
    "key" text,
    aliases text[],
    "exactAliases" text[],
    "genrePriority" smallint,
    "fallbackSlot" smallint,
    active boolean,
    "contentSha256" text,
    provenance jsonb
  )
)
insert into public.restaurant_image_catalog (
  image_key,
  genre_aliases,
  exact_genre_aliases,
  genre_priority,
  fallback_slot,
  active,
  content_sha256,
  provenance
)
select
  "key",
  aliases,
  "exactAliases",
  "genrePriority",
  "fallbackSlot",
  active,
  "contentSha256",
  provenance
from catalog_entries;
