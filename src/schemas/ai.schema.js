// Request validation for the AI product helpers.

const str = (max, extra = {}) => ({ type: "string", maxLength: max, ...extra });
const imageUrl = str(500, { format: "uri" });

export const analyzeSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["imageUrl"],
    properties: {
      imageUrl,
      // What the admin already typed, passed to the AI as context.
      hints: {
        type: "object",
        additionalProperties: false,
        properties: { name: str(120), category: str(60), gender: str(10), description: str(1000) },
      },
    },
  },
};
