import { createHash } from 'node:crypto';

const text = value => value == null ? '' : String(value).replace(/\s+/gu, ' ').trim();

export function parseRegistryDate(value) {
  if (value == null || value === '' || value === '0' || value === 0) return null;
  let milliseconds;
  if (/^\d{9,13}$/.test(String(value))) {
    milliseconds = Number(value) * (String(value).length <= 10 ? 1000 : 1);
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    milliseconds = Date.parse(value);
  } else {
    throw new Error('Parsing failed: unsupported registry date');
  }
  if (!Number.isFinite(milliseconds)) throw new Error('Parsing failed: invalid registry date');
  return new Date(milliseconds).toISOString();
}

export function parseResultPage(payload, expectedPage = 1) {
  if (!payload || !Array.isArray(payload.applist)) throw new Error('Parsing failed: expected applist array (not an error/login response)');
  const { page, lastpage, total } = payload;
  if (![page, lastpage, total].every(n => Number.isSafeInteger(n) && n >= 0) || page !== expectedPage ||
      (total > 0 && (lastpage < page || payload.applist.length === 0)) ||
      (total === 0 && (payload.applist.length !== 0 || lastpage > 1)) || payload.applist.length > total) {
    throw new Error('Parsing failed: inconsistent pagination metadata');
  }
  const entries = payload.applist.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Parsing failed: invalid result row');
    const applicationId = text(row.appID) || null;
    const registrationNumber = text(row.regNumber) || null;
    const documentId = text(row.documentId ?? row.documentID) || null;
    const description = text(row.webTransact);
    const status = text(row.status);
    const registeredAt = parseRegistryDate(row.appRegDate);
    const updatedAt = parseRegistryDate(row.lastActDate);
    const date = [registeredAt, updatedAt].filter(Boolean).sort().at(-1);
    if (!date || (!description && !status)) throw new Error('Parsing failed: result is missing a date or description');
    const key = createHash('sha256').update(JSON.stringify([
      applicationId, registrationNumber, documentId, registeredAt, updatedAt, description, status, text(row.statusId),
    ])).digest('hex');
    return { key, date, registeredAt, updatedAt, type: 'application', description, status, applicationId, registrationNumber, documentId };
  });
  return { entries, page, lastPage: lastpage, total };
}

export function completeResults(pages) {
  if (!pages.length) throw new Error('Parsing failed: no result pages');
  const { total, lastPage } = pages[0];
  if (pages.length !== Math.max(1, lastPage) || pages.some((p, i) => p.page !== i + 1 || p.total !== total || p.lastPage !== lastPage)) {
    throw new Error('Search failed: pagination changed or was incomplete; retry the complete search');
  }
  const entries = [...new Map(pages.flatMap(p => p.entries).map(e => [e.key, e])).values()];
  if (entries.length !== total) throw new Error('Search failed: result count changed or pages overlap; retry the complete search');
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}
