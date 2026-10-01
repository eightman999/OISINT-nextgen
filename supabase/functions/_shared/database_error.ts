// PostgREST / Supabase の永続化障害を semantic な `unknown` と区別する。
// 呼び出し側はこの例外を run step まで伝播させ、再試行可能な技術失敗として扱う。
export class DatabaseOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, message = "database operation failed") {
    super(`${operation}: ${message}`);
    this.name = "DatabaseOperationError";
    this.operation = operation;
  }
}

function databaseErrorMessage(error: unknown): string {
  if (
    typeof error === "object" && error !== null && "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export function throwIfDatabaseError(
  error: unknown | null | undefined,
  operation: string,
): void {
  if (error !== null && error !== undefined) {
    throw new DatabaseOperationError(operation, databaseErrorMessage(error));
  }
}
