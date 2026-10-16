import { z } from "zod";
import { Type, type TSchema } from "typebox";

type SchemaOptions = Readonly<{ maxLength?: number; maxItems?: number; minimum?: number; maximum?: number }>;

function checksOf(schema: z.ZodString | z.ZodNumber): readonly Readonly<{ kind: string; value?: number }>[] {
  return (schema._def.checks ?? []) as readonly Readonly<{ kind: string; value?: number }>[];
}
function optionsOf(schema: z.ZodString | z.ZodNumber): SchemaOptions {
  const options: Record<string, number> = {};
  for (const check of checksOf(schema)) {
    if (check.kind === "max") options[schema instanceof z.ZodString ? "maxLength" : "maximum"] = check.value!;
    if (check.kind === "min" && schema instanceof z.ZodNumber) options.minimum = check.value!;
  }
  return options;
}
function convert(schema: z.ZodTypeAny): TSchema {
  if (schema instanceof z.ZodOptional) return Type.Optional(convert(schema._def.innerType as z.ZodTypeAny));
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, TSchema> = {};
    for (const [key, value] of Object.entries(schema._def.shape() as Record<string, z.ZodTypeAny>))
      properties[key] = convert(value);
    return Type.Object(properties, { additionalProperties: false });
  }
  if (schema instanceof z.ZodString) return Type.String(optionsOf(schema));
  if (schema instanceof z.ZodNumber) return Type.Number(optionsOf(schema));
  if (schema instanceof z.ZodEnum) return Type.Enum(schema._def.values as readonly [string, ...string[]]);
  if (schema instanceof z.ZodArray) {
    const maxItems = schema._def.maxLength?.value;
    return Type.Array(convert(schema._def.type as z.ZodTypeAny), maxItems === undefined ? {} : { maxItems });
  }
  const typeName = (schema._def as Readonly<{ typeName?: string }>).typeName ?? "unknown";
  throw new Error(`Unsupported zod type for a TypeBox tool input: ${typeName}.`);
}

export function zodToTypeBox(schema: z.ZodTypeAny): TSchema {
  if (!(schema instanceof z.ZodObject)) throw new Error("A tool input schema must be a zod object at the top level.");
  return convert(schema);
}
