/** Suffix the document title and the text marked data-rer-name, without a bar. */
export function decorateLabel(response: Response, mode: 'Demo' | 'Dev', exit?: { name: string; url: string } | null): Promise<Response>;
