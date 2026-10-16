import { z } from "zod";

const description = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^[^\r\n\u0000-\u001f\u007f-\u009f]+$/u, "Plugin description must be one English sentence.");
const request = z
  .object({
    kind: z.literal("describe-plugin"),
    packageId: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
          !/^[A-Za-z]:/u.test(value) &&
          value.split("/").every((part) => part && part !== "." && part !== ".."),
      ),
    description,
  })
  .strict();
export type DescribePluginRequest = z.infer<typeof request>;
export function parsePluginDescription(value: unknown): string {
  const parsed = description.safeParse(value);
  if (!parsed.success)
    throw new Error("Plugin description must be a non-empty English sentence of at most 1,024 characters.");
  return parsed.data;
}
export function parseDescribePluginRequest(value: unknown): DescribePluginRequest {
  return request.parse(value);
}
