import {
  authenticate,
  createServiceClient,
  handleOptions,
  json,
} from "../_shared/db.ts";
import { resolveLocationBodySchema } from "../_shared/validation.ts";
import { resolveRailScope } from "../_shared/rail_resolver.ts";
import { readRequestBodyLimited } from "../_shared/request_body.ts";

const MAX_RESOLVE_LOCATION_BODY_BYTES = 16 * 1024;

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  const db = createServiceClient();
  const auth = await authenticate(req, db);
  if (!auth.userId && !auth.isServiceRole) {
    return json({ error: "認証が必要です" }, 401, req);
  }
  const boundedBody = await readRequestBodyLimited(
    req,
    MAX_RESOLVE_LOCATION_BODY_BYTES,
    { signal: req.signal },
  );
  if (boundedBody.timedOut) {
    return json(
      { error: "リクエスト本文の受信がタイムアウトしました" },
      408,
      req,
    );
  }
  if (boundedBody.tooLarge) {
    return json({ error: "リクエストが大きすぎます" }, 413, req);
  }
  if (boundedBody.readError) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  let body: unknown = null;
  let malformedJson = false;
  if (boundedBody.text.trim()) {
    try {
      body = JSON.parse(boundedBody.text) as unknown;
    } catch {
      malformedJson = true;
    }
  }
  if (malformedJson) {
    return json({ error: "リクエストが不正です" }, 400, req);
  }
  const parsed = resolveLocationBodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "location scope が不正です" }, 400, req);
  }
  const resolved = await resolveRailScope(db, parsed.data.scope);
  const { datasetVersionId: _internalDatasetVersionId, ...publicResolved } =
    resolved;
  return json(
    {
      ...publicResolved,
      scopeType: parsed.data.scope.type,
      dataset: resolved.dataset ?? null,
    },
    resolved.status === "resolved"
      ? 200
      : resolved.status === "unsupported"
      ? 422
      : 404,
    req,
  );
});
