export const errStr = (error: unknown, fallback?: string) =>
  error instanceof Error ? error.message : (fallback ?? String(error));

export const generalErrorHandler = (error: unknown, context?: string) => {
  console.log(errStr(error), context);
};
