export function formatErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message);
}

function redactSecrets(value: string): string {
  return value
    .replace(/(access_token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(refresh_token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(loginToken=)[^&\s]+/gi, "$1[redacted]")
    .replace(/("access_token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("refresh_token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("accessToken"\s*:\s*")[^"]+(")/g, "$1[redacted]$2")
    .replace(/("refreshToken"\s*:\s*")[^"]+(")/g, "$1[redacted]$2")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, "$1[redacted]");
}
