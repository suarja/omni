import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { z } from "zod";

import { zodToTypeBox } from "../../src/main/inference/providers/typebox-schema";

describe("zodToTypeBox", () => {
  it("converts the supported object, optional, enum, number, bounded string and array subset", () => {
    expect(
      zodToTypeBox(
        z.object({
          title: z.string().max(20),
          count: z.number().min(1).max(5),
          kind: z.enum(["left", "right"]),
          labels: z.array(z.string()).max(3),
          note: z.string().optional(),
        }),
      ),
    ).toEqual(
      Type.Object(
        {
          title: Type.String({ maxLength: 20 }),
          count: Type.Number({ minimum: 1, maximum: 5 }),
          kind: Type.Enum({ left: "left", right: "right" }),
          labels: Type.Array(Type.String(), { maxItems: 3 }),
          note: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    );
  });

  it("fails loudly for an unsupported schema instead of weakening the tool contract", () => {
    expect(() => zodToTypeBox(z.object({ value: z.union([z.string(), z.number()]) }))).toThrow(/Unsupported/);
  });
});
