// Torna (doc/view) HTTP client. Token & base URL come from env, never hardcoded.

export interface TornaProject {
  id: string;
  name: string;
  description: string;
  spaceId: string;
  isPrivate?: number;
}

export interface TornaSpace {
  id: string;
  name: string;
  projects: TornaProject[];
}

export interface ApiTreeNode {
  id: string;
  docId: string | null;
  label: string;
  url: string;
  httpMethod: string;
  /** 1 = service group, 3 = api leaf */
  type: number;
  parentId: string;
  apiCount: number;
}

export interface TornaConfig {
  baseUrl: string;
  token: string;
}

export function configFromEnv(): TornaConfig {
  const baseUrl = process.env.TORNA_BASE_URL ?? 'https://doc-dev.qijiswap.com';
  const token = process.env.TORNA_TOKEN ?? 'dJzAyzpZ:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjE3IiwiZXhwIjoxODE2MTM4ODU5LCJpYXQiOjE3ODQ2MDI4NTl9.DZoRPO0g28jfUzJepAXUdyPwMwtBoH2ncA8Uh5U4u-c';
  if (!token) {
    throw new Error(
      'Missing TORNA_TOKEN env var. Set it to the Torna `token` header value ' +
        '(see 接口/*.ts). Optionally set TORNA_BASE_URL (default doc-dev.qijiswap.com).',
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

interface Envelope<T> {
  code: string;
  data: T;
  msg: string;
}

export class TornaClient {
  constructor(private readonly cfg: TornaConfig) {}

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        token: this.cfg.token,
        Referer: `${this.cfg.baseUrl}/`,
      },
    });
    if (!res.ok) {
      throw new Error(`GET ${path} -> HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as Envelope<T>;
    if (body.code !== '0') {
      throw new Error(`GET ${path} -> torna code=${body.code} msg=${body.msg}`);
    }
    return body.data;
  }

  getProjects(): Promise<TornaSpace[]> {
    return this.getJson<TornaSpace[]>('/doc/view/projects');
  }

  getApiTree(projectId: string): Promise<ApiTreeNode[]> {
    return this.getJson<ApiTreeNode[]>(
      `/doc/view/dataByProject?projectId=${encodeURIComponent(projectId)}`,
    );
  }

  getDetail(docId: string): Promise<import('../codegen/emit.js').TornaDetail> {
    return this.getJson(`/doc/view/detail?id=${encodeURIComponent(docId)}`);
  }
}
