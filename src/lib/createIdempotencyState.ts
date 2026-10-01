import { createClientIdempotencyKey } from "./idempotencyKey";

type PendingCreate = {
  subjectKey: string;
  inputFingerprint: string;
  idempotencyKey: string;
};

/**
 * Keeps one key for retries of the same logical create during this app
 * process. Auth or input changes rotate the key; success clears it.
 */
export class CreateIdempotencyState {
  private pending: PendingCreate | null = null;

  constructor(private readonly createKey = createClientIdempotencyKey) {}

  keyFor(
    subjectKey: string,
    inputFingerprint: string,
  ): string {
    if (
      this.pending?.subjectKey === subjectKey &&
      this.pending.inputFingerprint === inputFingerprint
    ) {
      return this.pending.idempotencyKey;
    }
    const idempotencyKey = this.createKey();
    this.pending = {
      subjectKey,
      inputFingerprint,
      idempotencyKey,
    };
    return idempotencyKey;
  }

  /**
   * 古いcreateのresponseが後続subjectのretry stateを消さないよう、
   * responseが発行したsubject/input/keyに一致するときだけclearする。
   */
  clearIfMatches(
    subjectKey: string,
    inputFingerprint: string,
    idempotencyKey: string,
  ): boolean {
    if (
      this.pending?.subjectKey !== subjectKey ||
      this.pending.inputFingerprint !== inputFingerprint ||
      this.pending.idempotencyKey !== idempotencyKey
    ) {
      return false;
    }
    this.pending = null;
    return true;
  }
}
