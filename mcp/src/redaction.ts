/**
 * Safe secret redaction utility for MindVault MCP.
 *
 * Centralizes redaction for secret keys, API keys, payment headers, auth entries,
 * and bearer tokens to prevent accidental logging of sensitive information.
 */

/**
 * Redaction patterns for common secret formats
 */
const SECRET_PATTERNS = [
  // Stellar secret keys (S followed by 56 base32 characters)
  /S[A-Z2-7]{55}/g,
  // API keys (common patterns). `secret` is matched on its own too, so
  // "secret sk_live_…" in a free-form error message is redacted.
  /(?:api[_-]?key|apikey|secret(?:[_-]?key)?|auth[_-]?token|access[_-]?token)[\s=:]+[A-Za-z0-9\-_.]{20,}/gi,
  // Bearer tokens
  /bearer\s+[A-Za-z0-9\-_.]{20,}/gi,
  // Authorization headers
  /authorization[\s=:]+[^\s]+/gi,
  // x-api-key headers
  /x-api-key[\s=:]+[^\s]+/gi,
  // Generic long alphanumeric strings that look like secrets
  /\b[A-Za-z0-9]{32,}\b/g,
];

/**
 * Redact secrets from a string using common patterns.
 *
 * @param input - The string to redact secrets from
 * @returns The redacted string with secrets replaced by [REDACTED]
 */
export function redactSecrets(input: string): string {
  if (!input || typeof input !== "string") {
    return input;
  }

  let redacted = input;

  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }

  return redacted;
}

/**
 * Redact secrets from an object recursively.
 *
 * @param obj - The object to redact secrets from
 * @returns A new object with secrets redacted
 */
export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    return redactSecrets(obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as T;
  }

  if (typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj as any)) {
      // Redact known secret field names
      if (isSecretFieldName(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactObject(value);
      }
    }
    return result as T;
  }

  return obj;
}

/**
 * Check if a field name is likely to contain a secret.
 *
 * Matching is substring-based on the lowercased field name, so the markers
 * below also cover camelCase and snake_case spellings (`secret` covers
 * `secretKey`/`secret_key`, `apikey` covers `apiKey`/`api_key`/`x-api-key`).
 */
function isSecretFieldName(fieldName: string): boolean {
  const secretMarkers = [
    "secret",
    "privatekey",
    "private_key",
    "apikey",
    "api_key",
    "api-key",
    "accesstoken",
    "access_token",
    "authtoken",
    "auth_token",
    "password",
    "token",
    "bearer",
    "authorization",
  ];

  const lowerName = fieldName.toLowerCase();
  return secretMarkers.some((marker) => lowerName.includes(marker));
}

/**
 * Safe error logging that redacts secrets from error messages.
 *
 * @param error - The error to log
 * @returns A safe error message with secrets redacted
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }
  if (typeof error === "string") {
    return redactSecrets(error);
  }
  // Unknown shapes are redacted field-by-field first, so a secret-looking key
  // is masked even when its value is too short to match a pattern.
  return redactSecrets(JSON.stringify(redactObject(error)));
}

/**
 * Safe logging function that redacts secrets before output.
 *
 * @param data - The data to log safely
 * @returns A safe string representation with secrets redacted
 */
export function safeLog(data: unknown): string {
  try {
    const redacted = redactObject(data);
    return JSON.stringify(redacted, null, 2);
  } catch {
    return redactSecrets(String(data));
  }
}
