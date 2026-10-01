import { describe, expect, it, vi } from "vitest";

import { CreateIdempotencyState } from "./createIdempotencyState";

describe("CreateIdempotencyState", () => {
  it("timeout後の同じauth/input再試行は同じkeyを使う", () => {
    const createKey = vi.fn().mockReturnValueOnce("key-1");
    const state = new CreateIdempotencyState(createKey);

    expect(state.keyFor("user-a", "same-input")).toBe("key-1");
    // failure/timeoutではclearしない
    expect(state.keyFor("user-a", "same-input")).toBe("key-1");
    expect(createKey).toHaveBeenCalledOnce();
  });

  it("入力変更・auth変更・成功clearでは新しいkeyを使う", () => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce("key-1")
      .mockReturnValueOnce("key-2")
      .mockReturnValueOnce("key-3")
      .mockReturnValueOnce("key-4");
    const state = new CreateIdempotencyState(createKey);

    expect(state.keyFor("user-a", "input-a")).toBe("key-1");
    expect(state.keyFor("user-a", "input-b")).toBe("key-2");
    expect(state.keyFor("user-b", "input-b")).toBe("key-3");
    expect(
      state.clearIfMatches("user-b", "input-b", "key-3"),
    ).toBe(true);
    expect(state.keyFor("user-b", "input-b")).toBe("key-4");
  });

  it("UI auth generationが変わっても同一subject/inputではkeyを再利用する", () => {
    const createKey = vi.fn().mockReturnValueOnce("key-1");
    const state = new CreateIdempotencyState(createKey);

    expect(state.keyFor("user-a", "same-input")).toBe("key-1");
    expect(state.keyFor("user-a", "same-input")).toBe("key-1");
    expect(createKey).toHaveBeenCalledOnce();
  });

  it("旧subjectのresponseは後続subjectのretry keyをclearしない", () => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce("subject-a-key")
      .mockReturnValueOnce("subject-b-key")
      .mockReturnValueOnce("subject-b-after-success-key");
    const state = new CreateIdempotencyState(createKey);

    expect(state.keyFor("subject-a", "same-input")).toBe("subject-a-key");
    expect(state.keyFor("subject-b", "same-input")).toBe("subject-b-key");
    expect(
      state.clearIfMatches("subject-a", "same-input", "subject-a-key"),
    ).toBe(false);
    expect(state.keyFor("subject-b", "same-input")).toBe("subject-b-key");
    expect(
      state.clearIfMatches("subject-b", "same-input", "subject-b-key"),
    ).toBe(true);
    expect(state.keyFor("subject-b", "same-input")).toBe(
      "subject-b-after-success-key",
    );
  });
});
