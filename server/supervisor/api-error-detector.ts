// Tracks API billing/auth errors during a run so the user can be notified

let _lastBillingError: { provider: string; status: number; message: string; timestamp: number } | null = null;

export function detectBillingError(
  provider: 'openai' | 'anthropic',
  statusCode: number,
  errorBody: string,
): boolean {
  // OpenAI billing errors
  if (provider === 'openai' && (statusCode === 402 || statusCode === 429)) {
    _lastBillingError = {
      provider,
      status: statusCode,
      message: statusCode === 402
        ? 'OpenAI API credits exhausted — add credits at platform.openai.com/billing'
        : 'OpenAI API rate limit hit — may be temporary',
      timestamp: Date.now(),
    };
    return true;
  }

  // OpenAI insufficient_quota error (can come as 400 or 403)
  if (provider === 'openai' && errorBody.includes('insufficient_quota')) {
    _lastBillingError = {
      provider,
      status: statusCode,
      message: 'OpenAI API credits exhausted — add credits at platform.openai.com/billing',
      timestamp: Date.now(),
    };
    return true;
  }

  // Anthropic billing errors
  if (provider === 'anthropic' && (statusCode === 402 || statusCode === 429)) {
    _lastBillingError = {
      provider,
      status: statusCode,
      message: statusCode === 402
        ? 'Anthropic API credits exhausted'
        : 'Anthropic API rate limit hit',
      timestamp: Date.now(),
    };
    return true;
  }

  return false;
}

export function getLastBillingError(): typeof _lastBillingError {
  // Only return errors from the last 10 minutes
  if (_lastBillingError && Date.now() - _lastBillingError.timestamp < 600_000) {
    return _lastBillingError;
  }
  return null;
}

export function clearBillingError(): void {
  _lastBillingError = null;
}
