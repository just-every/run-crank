import { CrankApiError } from './errors.js';
import { transport } from './transport.js';

export { CrankApiError } from './errors.js';
export const API_VERSION = '1';
const segment = value => {
  if (typeof value !== 'string' || !value || value === '.' || value === '..') {
    throw new CrankApiError('A nonempty record ID is required', { code: 'invalid_request' });
  }
  return encodeURIComponent(value);
};

/** Dependency-free client for Crank's authenticated v1 HTTP doors. */
export class CrankClient {
  #request;
  constructor(options) { this.#request = transport(options); }

  async createDraft(input, options = {}) {
    return this.#request('POST', 'workflows', { ...options, body: input });
  }
  async readWorkflow(workflowId, options = {}) {
    return this.#request('GET', `workflows/${segment(workflowId)}`, options);
  }
  async readDraft(workflowId, draftId, options = {}) {
    return this.#request('GET', `workflows/${segment(workflowId)}/drafts/${segment(draftId)}`, options);
  }
  async updateDraft(workflowId, input, options = {}) {
    return this.#request('POST', `workflows/${segment(workflowId)}/draft`, { ...options, body: input });
  }
  async validateDraft(workflowId, input = {}, options = {}) {
    return this.#request('POST', `workflows/${segment(workflowId)}/validate`, { ...options, body: input });
  }
  async publishDraft(workflowId, input = {}, options = {}) {
    return this.#request('POST', `workflows/${segment(workflowId)}/publish`, { ...options, body: input });
  }
  async listWorkflows(query = {}, options = {}) {
    return this.#request('GET', 'workflows', { ...options, query });
  }
  async listRuns(query = {}, options = {}) {
    const page = await this.#request('GET', 'workflow-runs', { ...options, query });
    if (!page || !Array.isArray(page.runs) || !(page.next === null || (typeof page.next === 'string' && page.next))) {
      throw new CrankApiError('Crank returned an invalid run page', { code: 'invalid_response', status: 200 });
    }
    return page;
  }
  async *iterateRuns(query = {}, options = {}) {
    let before = query.before;
    const seen = new Set(before ? [before] : []);
    for (;;) {
      const page = await this.listRuns({ ...query, before }, options);
      for (const run of page.runs) yield run;
      if (page.next === null) return;
      if (seen.has(page.next)) throw new CrankApiError('Crank repeated a run pagination cursor', { code: 'invalid_response', status: 200 });
      seen.add(page.next);
      before = page.next;
    }
  }
  async readRun(runId, options = {}) {
    return this.#request('GET', `workflow-runs/${segment(runId)}`, options);
  }
  async startTask(input, options = {}) {
    return this.#request('POST', 'agent-tasks', { ...options, body: input });
  }
  async readTask(runId, options = {}) {
    return this.#request('GET', `agent-tasks/${segment(runId)}`, options);
  }
}

export function createCrankClient(options) { return new CrankClient(options); }
