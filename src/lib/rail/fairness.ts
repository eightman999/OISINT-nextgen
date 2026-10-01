export type TransitMatrixRequest = {
  /** resolverが確定した起点ID。利用者の入力本文は渡さない。 */
  origins: readonly string[];
  /** 比較対象となる候補エリアID。 */
  candidates: readonly string[];
  /** providerへ問い合わせる日時。時刻や曜日を推測せず呼び出し側が指定する。 */
  departureAt: string;
};

export type TransitMatrixCell = {
  origin: string;
  candidate: string;
  minutes: number;
};

export type TransitMatrix = {
  request: TransitMatrixRequest;
  source: {
    providerId: string;
    datasetVersion: string;
  };
  cells: readonly TransitMatrixCell[];
};

export interface TransitMatrixProvider {
  getTransitMatrix(request: TransitMatrixRequest): Promise<TransitMatrix>;
}

export type TransitFairnessUnavailableReason =
  | 'insufficient_origins'
  | 'no_candidates'
  | 'invalid_identifier'
  | 'duplicate_identifier'
  | 'invalid_departure_time'
  | 'invalid_source'
  | 'invalid_duration'
  | 'duplicate_cell'
  | 'unexpected_cell'
  | 'incomplete_matrix'
  | 'numeric_overflow'
  | 'provider_unavailable'
  | 'provider_request_mismatch';

export type RankedTransitCandidate = {
  candidate: string;
  maxMinutes: number;
  totalMinutes: number;
  averageMinutes: number;
  populationVariance: number;
  access: readonly { origin: string; minutes: number }[];
};

export type TransitFairnessResult =
  | {
    status: 'ranked';
    source: TransitMatrix['source'];
    departureAt: string;
    candidates: readonly RankedTransitCandidate[];
  }
  | {
    status: 'unavailable';
    reason: TransitFairnessUnavailableReason;
    /** raw queryや位置座標を含めず、欠損したIDの組だけを返す。 */
    missingCells?: readonly { origin: string; candidate: string }[];
  };

function unavailable(
  reason: TransitFairnessUnavailableReason,
  missingCells?: readonly { origin: string; candidate: string }[],
): TransitFairnessResult {
  return missingCells?.length
    ? { status: 'unavailable', reason, missingCells }
    : { status: 'unavailable', reason };
}

function hasCanonicalIdentifiers(values: readonly string[]): boolean {
  return values.every((value) => value.length > 0 && value === value.trim());
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sameRequest(left: TransitMatrixRequest, right: TransitMatrixRequest): boolean {
  return (
    left.departureAt === right.departureAt &&
    left.origins.length === right.origins.length &&
    left.origins.every((value, index) => value === right.origins[index]) &&
    left.candidates.length === right.candidates.length &&
    left.candidates.every((value, index) => value === right.candidates[index])
  );
}

function compareIdentifier(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isExplicitDepartureTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

/**
 * 完全なTransit所要時間matrixを、最大時間→合計時間→分散の順で比較する。
 *
 * matrixが欠けている場合は一部候補だけを順位付けしない。架空の所要時間や
 * 直線距離による補完も行わず、全体を unavailable として返す。
 */
export function rankTransitFairness(matrix: TransitMatrix): TransitFairnessResult {
  const { origins, candidates, departureAt } = matrix.request;
  if (origins.length < 2) return unavailable('insufficient_origins');
  if (candidates.length === 0) return unavailable('no_candidates');
  if (!hasCanonicalIdentifiers(origins) || !hasCanonicalIdentifiers(candidates)) {
    return unavailable('invalid_identifier');
  }
  if (hasDuplicates(origins) || hasDuplicates(candidates)) {
    return unavailable('duplicate_identifier');
  }
  if (!isExplicitDepartureTime(departureAt)) {
    return unavailable('invalid_departure_time');
  }
  if (
    !matrix.source.providerId ||
    matrix.source.providerId !== matrix.source.providerId.trim() ||
    !matrix.source.datasetVersion ||
    matrix.source.datasetVersion !== matrix.source.datasetVersion.trim()
  ) {
    return unavailable('invalid_source');
  }

  const originSet = new Set(origins);
  const candidateSet = new Set(candidates);
  const cells = new Map<string, number>();
  const keyFor = (origin: string, candidate: string) => JSON.stringify([origin, candidate]);

  for (const cell of matrix.cells) {
    if (!originSet.has(cell.origin) || !candidateSet.has(cell.candidate)) {
      return unavailable('unexpected_cell');
    }
    if (!Number.isFinite(cell.minutes) || cell.minutes < 0) {
      return unavailable('invalid_duration');
    }
    const key = keyFor(cell.origin, cell.candidate);
    if (cells.has(key)) return unavailable('duplicate_cell');
    cells.set(key, cell.minutes);
  }

  const missingCells = candidates.flatMap((candidate) =>
    origins
      .filter((origin) => !cells.has(keyFor(origin, candidate)))
      .map((origin) => ({ origin, candidate })),
  );
  if (missingCells.length > 0) return unavailable('incomplete_matrix', missingCells);

  const ranked: RankedTransitCandidate[] = [];
  for (const candidate of candidates) {
    const access = origins.map((origin) => ({
      origin,
      minutes: cells.get(keyFor(origin, candidate))!,
    }));
    const totalMinutes = access.reduce((sum, entry) => sum + entry.minutes, 0);
    const averageMinutes = totalMinutes / access.length;
    const populationVariance =
      access.reduce((sum, entry) => sum + (entry.minutes - averageMinutes) ** 2, 0) /
      access.length;
    const maxMinutes = Math.max(...access.map((entry) => entry.minutes));
    if (
      !Number.isFinite(totalMinutes) ||
      !Number.isFinite(averageMinutes) ||
      !Number.isFinite(populationVariance) ||
      !Number.isFinite(maxMinutes)
    ) {
      return unavailable('numeric_overflow');
    }
    ranked.push({
      candidate,
      maxMinutes,
      totalMinutes,
      averageMinutes,
      populationVariance,
      access,
    });
  }

  ranked.sort(
    (left, right) =>
      left.maxMinutes - right.maxMinutes ||
      left.totalMinutes - right.totalMinutes ||
      left.populationVariance - right.populationVariance ||
      compareIdentifier(left.candidate, right.candidate),
  );
  return {
    status: 'ranked',
    source: { ...matrix.source },
    departureAt,
    candidates: ranked,
  };
}

/** provider応答が依頼matrixと一致する場合だけ純粋な順位付けへ渡す。 */
export async function rankTransitFairnessFromProvider(
  provider: TransitMatrixProvider,
  request: TransitMatrixRequest,
): Promise<TransitFairnessResult> {
  let matrix: TransitMatrix;
  try {
    matrix = await provider.getTransitMatrix(request);
  } catch {
    return unavailable('provider_unavailable');
  }
  if (!sameRequest(matrix.request, request)) {
    return unavailable('provider_request_mismatch');
  }
  return rankTransitFairness(matrix);
}
