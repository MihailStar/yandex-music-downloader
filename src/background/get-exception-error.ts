class UnknownError extends Error {
  public override name = 'UnknownError';

  public constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function getExceptionError(reason: unknown): Error {
  const error =
    reason instanceof Error
      ? reason
      : new UnknownError(undefined, {cause: reason});

  return error;
}
