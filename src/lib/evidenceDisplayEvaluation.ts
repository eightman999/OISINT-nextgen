import type { Evidence, MatchState, Requirement } from '@/types';

type DeterministicState = Exclude<MatchState, 'unknown'>;
type DisplayDeterministicKind = 'payment' | 'budget' | 'reservation' | 'party_size' | 'time';

export function isDisplayDeterministicRequirement(requirement: Requirement): boolean {
  return displayDeterministicKind(requirement) !== undefined ||
    inferredDeterministicKind(requirement) !== undefined ||
    hasUnsupportedDeterministicIntent(requirement);
}

function canonical(text: string): string {
  return text.normalize('NFKC').trim().replaceAll(/\s+/g, '');
}

function sameIntent<T>(left: T | null, right: T | null): T | null {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right)
    ? right
    : null;
}

function parsePayment(text: string): boolean | null {
  const value = canonical(text);
  const prefix = '(?:支払い(?:方法)?(?:は|:)?)?';
  const card = '(?:クレジットカード|クレカ|カード)';
  if (new RegExp(`^${prefix}${card}(?:利用不可|利用できない|払い不可|決済不可|が使えない|は使えない|非対応|不可)$`).test(value)) {
    return false;
  }
  return new RegExp(
    `^${prefix}${card}(?:利用可能|利用可|利用できる|払い可能|払い可|払いしたい|で払いたい|を使いたい|決済可能|決済可|が使える|は使える|対応|可)(?:がいい|が希望|を希望|希望です|希望)?$`
  ).test(value)
    ? true
    : null;
}

type ReservationIntent = { subject: 'reservation' | 'private_room'; desired: boolean };

function parseReservation(text: string): ReservationIntent | null {
  const value = canonical(text);
  const asksReservation = value.includes('予約');
  const asksPrivateRoom = value.includes('個室');
  if (asksReservation === asksPrivateRoom) return null;
  if (asksReservation) {
    if (/^予約(?:が|は)?(?:不可|できない|できません|非対応)$/.test(value)) {
      return { subject: 'reservation', desired: false };
    }
    if (
      /^予約(?:が|は)?(?:可能|できる|対応|受付中|可)(?:がいい|が希望|を希望|希望です|希望)?$/.test(value) ||
      /^予約(?:したい|希望)?(?:です)?$/.test(value)
    ) {
      return { subject: 'reservation', desired: true };
    }
    return null;
  }
  if (/^個室(?:が|は)?(?:なし|無し|ありません|不可|利用不可|利用できない|非対応)$/.test(value)) {
    return { subject: 'private_room', desired: false };
  }
  if (
    /^個室(?:が|は)?(?:あり|有り|あります|利用可能|利用可|可能|可|希望)?(?:です)?$/.test(value) ||
    /^個室で(?:静か|落ち着いた)(?:店|ところ)?$/.test(value)
  ) {
    return { subject: 'private_room', desired: true };
  }
  return null;
}

function parsePartySize(text: string): number | null {
  const match = canonical(text).match(
    /^(?:人数(?:は|:)?)?([0-9]+)人(?:で)?(?:利用可能|利用可|利用できる|予約可能|予約可|行きたい|予約したい|希望)?(?:です)?$/
  );
  const people = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(people) && people > 0 ? people : null;
}

type BudgetIntent =
  | { operator: 'max_inclusive'; amount: number }
  | { operator: 'max_strict'; amount: number }
  | { operator: 'min_inclusive'; amount: number }
  | { operator: 'around'; amount: number }
  | { operator: 'vague_max'; amount: number; tolerance: number }
  | { operator: 'range'; min: number; max: number };

function amount(raw: string, tenThousands: boolean): number | null {
  const value = Number(raw.replaceAll(',', '')) * (tenThousands ? 10_000 : 1);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseBudget(text: string): BudgetIntent | null {
  const value = canonical(text);
  const prefix = '(?:(?:希望)?予算(?:は|:)?|(?:一人|1人)(?:あたり)?(?:は|:)?)?';
  const suffix = '(?:を希望|が希望|希望です|希望|でお願いします|がいい|で)?';
  const range = value.match(new RegExp(
    `^${prefix}([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円?(?:〜|~|－|–|—|-|から)([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円(?:まで)?${suffix}$`
  ));
  if (range) {
    const min = amount(range[1], range[2] === '万');
    const max = amount(range[3], range[4] === '万');
    return min !== null && max !== null && min <= max ? { operator: 'range', min, max } : null;
  }
  const operation = value.match(new RegExp(
    `^${prefix}([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円(以下|以内|まで|未満|以上|前後)${suffix}$`
  ));
  if (operation) {
    const parsed = amount(operation[1], operation[2] === '万');
    if (parsed === null) return null;
    const operator = operation[3];
    if (operator === '以下' || operator === '以内' || operator === 'まで') {
      return { operator: 'max_inclusive', amount: parsed };
    }
    if (operator === '未満') return { operator: 'max_strict', amount: parsed };
    if (operator === '以上') return { operator: 'min_inclusive', amount: parsed };
    return { operator: 'around', amount: parsed };
  }
  const around = value.match(new RegExp(
    `^${prefix}([0-9][0-9,]*(?:\\.[0-9]+)?)(万)?円(?:くらい|程度)?${suffix}$`
  ));
  const parsed = around ? amount(around[1], around[2] === '万') : null;
  if (parsed !== null) return { operator: 'around', amount: parsed };
  if (/^(?:安い|安め|お手頃|手頃|リーズナブル|格安|激安|コスパ)(?:な)?(?:価格帯|店|お店|ところ)?$/.test(value)) {
    return { operator: 'vague_max', amount: 3000, tolerance: 600 };
  }
  return null;
}

function compareBudget(intent: BudgetIntent, range: { min: number; max: number }): DeterministicState {
  if (intent.operator === 'vague_max') {
    return range.max <= intent.amount
      ? 'match'
      : range.min > intent.amount + intent.tolerance
        ? 'mismatch'
        : 'partial';
  }
  if (intent.operator === 'max_inclusive') {
    return range.max <= intent.amount ? 'match' : range.min > intent.amount ? 'mismatch' : 'partial';
  }
  if (intent.operator === 'max_strict') {
    return range.max < intent.amount ? 'match' : range.min >= intent.amount ? 'mismatch' : 'partial';
  }
  if (intent.operator === 'min_inclusive') {
    return range.min >= intent.amount ? 'match' : range.max < intent.amount ? 'mismatch' : 'partial';
  }
  if (intent.operator === 'around') {
    return range.min <= intent.amount && intent.amount <= range.max ? 'match' : 'mismatch';
  }
  return range.min >= intent.min && range.max <= intent.max
    ? 'match'
    : range.max < intent.min || range.min > intent.max
      ? 'mismatch'
      : 'partial';
}

type TimeWindow = { start: number; end: number };

function parseTime(text: string): TimeWindow | null {
  const value = canonical(text).replace(/(?:がいい|が希望|に行きたい|を希望|希望です|希望)$/, '');
  const windows: { pattern: RegExp; window: TimeWindow }[] = [
    { pattern: /^(?:深夜|夜中)(?:の時間帯)?(?:に)?(?:まで)?(?:営業(?:している)?|やって(?:いる|る)(?:ところ)?|利用(?:したい|できる))?$/, window: { start: 1380, end: 1740 } },
    { pattern: /^(?:モーニング|朝食|朝ご飯|朝ごはん|朝)(?:の時間帯)?(?:に)?(?:営業(?:している)?|やって(?:いる|る)(?:ところ)?|利用(?:したい|できる))?$/, window: { start: 360, end: 600 } },
    { pattern: /^(?:ランチ|昼食|昼ご飯|昼ごはん|お昼|昼)(?:の時間帯)?(?:に)?(?:営業(?:している)?|利用(?:したい|できる)?)?$/, window: { start: 660, end: 840 } },
    { pattern: /^(?:夕方)(?:の時間帯)?(?:に)?(?:営業(?:している)?|利用(?:したい|できる))?$/, window: { start: 960, end: 1080 } },
    { pattern: /^(?:ディナー|夕食|晩ご飯|晩ごはん|夜ごはん|夜)(?:の時間帯)?(?:に)?(?:営業(?:している)?|利用(?:したい|できる))?$/, window: { start: 1080, end: 1320 } },
  ];
  const matched = windows.filter(({ pattern }) => pattern.test(value));
  return matched.length === 1 ? matched[0].window : null;
}

function parseHours(value: unknown): { open: number; close: number } | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [openHour, openMinute, closeHour, closeMinute] = match.slice(1).map(Number);
  if (
    openHour > 24 || openMinute > 59 || closeHour > 24 || closeMinute > 59 ||
    (openHour === 24 && openMinute !== 0) ||
    (closeHour === 24 && closeMinute !== 0)
  ) return null;
  const open = openHour * 60 + openMinute;
  let close = closeHour * 60 + closeMinute;
  if (close <= open) close += 1440;
  return { open, close };
}

function compareTime(window: TimeWindow, rawHours: unknown): DeterministicState | null {
  const hours = parseHours(rawHours);
  if (!hours) return null;
  let overlap = Number.NEGATIVE_INFINITY;
  for (const shift of [0, 1440]) {
    overlap = Math.max(
      overlap,
      Math.min(window.end, hours.close + shift) - Math.max(window.start, hours.open + shift)
    );
  }
  if (overlap >= 60) return 'match';
  if (overlap > 0) return 'partial';
  if (window.end <= hours.open) return 'mismatch';
  return null;
}

function combineStates(states: DeterministicState[], conflict = false): DeterministicState | undefined {
  if (states.length === 0) return undefined;
  return conflict || new Set(states).size > 1 ? 'partial' : states[0];
}

function inferredDeterministicKind(requirement: Requirement): DisplayDeterministicKind | undefined {
  const candidates: DisplayDeterministicKind[] = [];
  if (sameIntent(parsePayment(requirement.text), parsePayment(requirement.normalizedText)) !== null) {
    candidates.push('payment');
  }
  if (sameIntent(parseBudget(requirement.text), parseBudget(requirement.normalizedText)) !== null) {
    candidates.push('budget');
  }
  if (sameIntent(parseReservation(requirement.text), parseReservation(requirement.normalizedText)) !== null) {
    candidates.push('reservation');
  }
  if (sameIntent(parsePartySize(requirement.text), parsePartySize(requirement.normalizedText)) !== null) {
    candidates.push('party_size');
  }
  if (sameIntent(parseTime(requirement.text), parseTime(requirement.normalizedText)) !== null) {
    candidates.push('time');
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function hasUnsupportedDeterministicIntent(requirement: Requirement): boolean {
  if (requirement.kind !== 'other') return false;
  const isUnlimitedStayPreference = (value: string) =>
    /^(?:時間制限(?:なし|無し)|時間無制限)(?:で)?(?:ゆっくり(?:できる|したい)?|滞在(?:できる|したい)?)?$/.test(
      canonical(value)
    );
  if (
    isUnlimitedStayPreference(requirement.text) &&
    isUnlimitedStayPreference(requirement.normalizedText)
  ) return false;
  const genericNoConstraint = /^(?:条件(?:は)?(?:なし|無し)|おまかせ|指定(?:は)?(?:なし|無し)|指定しない|何人でも(?:よい|いい|可)?|何でも(?:よい|いい|可)?|どちらでも(?:よい|いい|可)?|上限(?:なし|無し)|下限(?:なし|無し)|制限(?:なし|無し))$/;
  const potentialIntent = [
    /(?:クレジットカード|クレカ|カード)(?=$|は|を|が|で|利用|払い|決済|可|不|非|しか|だけ)/,
    /現金(?=$|は|を|が|で|のみ|だけ)/,
    /(?:予約|個室)(?=$|は|を|が|で|可|不|利|希望|し|な|有|あ|O)/,
    /人数|参加者|メンバー|[0-9]+人/,
    /予算|金額|料金|価格|[0-9]+(?:\.[0-9]+)?(?:万)?円|安い|安め|お手頃|手頃|リーズナブル|格安|激安|コスパ/,
    /(?:深夜|夜中|モーニング|朝食|朝ご飯|朝ごはん|朝|ランチ|昼食|昼ご飯|昼ごはん|お昼|昼|夕方|ディナー|夕食|晩ご飯|晩ごはん|夜)(?:の?時間帯|営業|型|限定)?(?=$|は|を|が|に|で|の|以外|または|あるいは|や|不要|なし|無し|未定|問わない|避け|除外|嫌|無理|困る)/,
    /(?:営業時間|時間帯|時間指定|時間)(?:は|を|が)?(?:不要|なし|無し|未定|問わない|指定なし)/,
  ];
  // Keep the no-constraint forms in lockstep with requirement_source.ts.
  // A domain prefix may precede these forms (e.g. 費用指定はなし), so the
  // whole-string genericNoConstraint check alone is insufficient.
  const negativeOrUnspecified = /不要|未定|不問|問わない|こだわらない|おまかせ|指定(?:は)?(?:なし|無し)|指定しない|何人でも(?:よい|いい|可)?|どちらでも(?:よい|いい|可)?|何でも(?:よい|いい|可)?|上限(?:なし|無し)|下限(?:なし|無し)|制限(?:なし|無し)|条件(?:は)?(?:なし|無し)|使わない|使いたくない|利用しない|予約しない|避けたい|除外|以外|のみ/;
  const deterministicDomain = /クレジットカード|クレカ|カード(?!ゲーム)|支払|決済|現金|予約(?!語)|個室|席種|座席|予算|費用|値段|金額|料金|価格|単価|上限|下限|人数|参加者|同行者|メンバー|グループ|何人|[0-9]+(?:万)?円|[0-9]+人|営業時間|時間帯|時間指定|時間|日時|日程|朝(?!霞|鮮)|昼|ランチ(?!コース)|ディナー|夜(?!景|行)|深夜|夕方/;
  return [requirement.text, requirement.normalizedText]
    .map(canonical)
    .some((value) =>
      genericNoConstraint.test(value) ||
      potentialIntent.some((pattern) => pattern.test(value)) ||
      (negativeOrUnspecified.test(value) && deterministicDomain.test(value))
    );
}

function displayDeterministicKind(requirement: Requirement): DisplayDeterministicKind | undefined {
  if (['payment', 'budget', 'reservation', 'party_size', 'time'].includes(requirement.kind)) {
    return requirement.kind as DisplayDeterministicKind;
  }
  // DB kind=null の参加者追加条件だけは、文面の両表現が同じ1種類の
  // 決定論intentにparseできる場合に限りbackendと同様にkindを推定する。
  // parserが明示的にotherを返した行は、捏造されたkindをclientで救済しない。
  return requirement.userAdded === true ? inferredDeterministicKind(requirement) : undefined;
}

export function deterministicDisplayState(
  requirement: Requirement,
  evidence: readonly Evidence[]
): DeterministicState | undefined {
  const claims = evidence.flatMap((row) => row.structuredClaims);
  const kind = displayDeterministicKind(requirement);
  if (kind === 'payment') {
    const desired = sameIntent(parsePayment(requirement.text), parsePayment(requirement.normalizedText));
    if (desired === null) return undefined;
    const values = claims.filter((claim) => claim.key === 'card_accepted' && typeof claim.value === 'boolean');
    const bools = values.map((claim) => claim.value as boolean);
    return combineStates(bools.map((value) => value === desired ? 'match' : 'mismatch'), new Set(bools).size > 1);
  }
  if (kind === 'reservation') {
    const intent = sameIntent(parseReservation(requirement.text), parseReservation(requirement.normalizedText));
    if (!intent) return undefined;
    const values = claims.filter((claim) => claim.key === intent.subject && typeof claim.value === 'boolean');
    const bools = values.map((claim) => claim.value as boolean);
    return combineStates(bools.map((value) => value === intent.desired ? 'match' : 'mismatch'), new Set(bools).size > 1);
  }
  if (kind === 'party_size') {
    const people = sameIntent(parsePartySize(requirement.text), parsePartySize(requirement.normalizedText));
    if (people === null) return undefined;
    const capacities = claims
      .filter((claim) => claim.key === 'capacity' && typeof claim.value === 'number' && Number.isFinite(claim.value) && claim.value > 0)
      .map((claim) => claim.value as number);
    const conflict = capacities.some((value, index) =>
      capacities.slice(index + 1).some((other) => Math.max(value, other) >= 2 * Math.min(value, other))
    );
    return combineStates(capacities.map((value) => value >= people ? 'partial' : 'mismatch'), conflict);
  }
  if (kind === 'budget') {
    const intent = sameIntent(parseBudget(requirement.text), parseBudget(requirement.normalizedText));
    if (!intent) return undefined;
    const ranges = claims.flatMap((claim) => {
      const value = claim.value as { min?: unknown; max?: unknown } | null;
      return claim.key === 'budget_dinner' &&
          typeof value?.min === 'number' && Number.isFinite(value.min) && value.min >= 0 &&
          typeof value.max === 'number' && Number.isFinite(value.max) && value.min <= value.max
        ? [{ min: value.min, max: value.max }]
        : [];
    });
    const conflict = ranges.some((range, index) =>
      ranges.slice(index + 1).some((other) => range.max < other.min || other.max < range.min)
    );
    return combineStates(ranges.map((range) => compareBudget(intent, range)), conflict);
  }
  if (kind === 'time') {
    const window = sameIntent(parseTime(requirement.text), parseTime(requirement.normalizedText));
    if (!window) return undefined;
    const hours = claims.filter((claim) => claim.key === 'opening_hours').map((claim) => claim.value);
    const states = hours.flatMap((value) => {
      const state = compareTime(window, value);
      return state ? [state] : [];
    });
    const closings = hours.flatMap((value) => {
      const parsed = parseHours(value);
      return parsed ? [parsed.close] : [];
    });
    const conflict = closings.some((close, index) =>
      closings.slice(index + 1).some((other) => Math.abs(close - other) >= 30)
    );
    return combineStates(states, conflict);
  }
  return undefined;
}
