export function queryRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) throw new Error('UNEXPECTED_QUERY_RESULT');
  if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return result as T[];
}
