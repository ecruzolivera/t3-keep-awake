// Only these deliberately composed messages cross the logging boundary. Never
// print HTTP bodies, WebSocket close reasons, credentials, URLs or raw errors.
export class AppError extends Error {
  constructor(code, message, fatal = false) {
    super(message);
    this.code = code;
    this.fatal = fatal;
  }
}
export const protocolError = () => new AppError('protocol', 'Unsupported T3 protocol or malformed status stream; check compatibility and upgrade the companion.', true);
export const authError = () => new AppError('auth', 'Pairing expired, revoked, or lacks read permission. Create a new read-only pairing and run pair again.', true);
export function safeError(error) {
  return error instanceof AppError ? error.message : 'Operation failed. Check configuration, local T3 availability, and journal diagnostics.';
}
