import { describe, expect, it } from "vitest";

import { redactSensitiveValue } from "@local-ai-gateway/shared";

describe("redactSensitiveValue", () => {
  it("keeps ordinary diagnostic text readable", () => {
    expect(redactSensitiveValue("access denied while refreshing usage")).toBe(
      "access denied while refreshing usage",
    );
  });

  it("redacts bearer token text and sensitive object keys", () => {
    expect(
      redactSensitiveValue(
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock.payload.signature",
      ),
    ).toBe("[redacted]");

    expect(
      redactSensitiveValue({
        access_token: "abc",
        refreshToken: "def",
        message: "network timeout",
      }),
    ).toEqual({
      access_token: "[redacted]",
      refreshToken: "[redacted]",
      message: "network timeout",
    });
  });
});
