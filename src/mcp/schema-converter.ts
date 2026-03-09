/**
 * JSON Schema → Zod shape converter.
 * Converts the JSON Schema parameter objects used by ToolRegistry definitions
 * into Zod raw shapes compatible with McpServer.registerTool().
 *
 * Handles the subset used by our tools: string, number, integer, boolean,
 * array (of strings), enum, required, and description.
 */

import { z } from "zod";

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: (string | number)[];
  items?: { type: string };
}

interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** Convert a single JSON Schema property to a Zod type. */
function propertyToZod(prop: JsonSchemaProperty, isRequired: boolean): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  switch (prop.type) {
    case "string":
      if (prop.enum && prop.enum.every((v) => typeof v === "string")) {
        const values = prop.enum as [string, ...string[]];
        schema = z.enum(values);
      } else {
        schema = z.string();
      }
      break;

    case "number":
    case "integer":
      if (prop.enum && prop.enum.every((v) => typeof v === "number")) {
        // Zod doesn't have z.enum for numbers directly; use z.union of literals
        const literals = prop.enum.map((v) => z.literal(v as number));
        schema =
          literals.length === 1
            ? literals[0]
            : z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
      } else {
        schema = prop.type === "integer" ? z.number().int() : z.number();
      }
      break;

    case "boolean":
      schema = z.boolean();
      break;

    case "array":
      if (prop.items?.type === "string") {
        schema = z.array(z.string());
      } else if (prop.items?.type === "number" || prop.items?.type === "integer") {
        schema = z.array(z.number());
      } else {
        // Default to array of strings
        schema = z.array(z.string());
      }
      break;

    default:
      schema = z.string();
      break;
  }

  if (prop.description) {
    schema = schema.describe(prop.description);
  }

  if (!isRequired) {
    schema = schema.optional();
  }

  return schema;
}

/**
 * Convert a JSON Schema object (as used by ToolDefinition.parameters) to a
 * Zod raw shape suitable for McpServer.registerTool()'s inputSchema.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const obj = schema as unknown as JsonSchemaObject;
  const properties = obj.properties ?? {};
  const required = new Set(obj.required ?? []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    shape[key] = propertyToZod(prop, required.has(key));
  }

  return shape;
}
