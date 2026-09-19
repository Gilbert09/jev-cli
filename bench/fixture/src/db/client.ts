export interface Row { [k: string]: unknown; }
export async function query<T = Row>(_sql: string, _params: unknown[] = []): Promise<T[]> { return []; }
