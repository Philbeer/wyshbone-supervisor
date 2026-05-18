export interface ConstraintLike {
  type: string;
  field: string;
  operator: string;
  value: string | number | boolean | null;
  value_secondary?: string | number | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function readableDate(isoOrRaw: string): string {
  const trimmed = isoOrRaw.trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const day = parseInt(isoMatch[3], 10);
    const month = MONTH_NAMES[parseInt(isoMatch[2], 10) - 1];
    const year = isoMatch[1];
    return `${day} ${month} ${year}`;
  }
  return trimmed;
}

function readableDateWithIso(iso: string): string {
  const readable = readableDate(iso);
  const isIso = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
  return isIso ? `${readable} (${iso.trim()})` : readable;
}

interface ParsedDuration {
  n: number;
  unit: 'days' | 'weeks' | 'months' | 'years';
  raw: string;
}

function parseDuration(value: string): ParsedDuration | null {
  const m = value.trim().match(/^(\d+)\s*(day|days|week|weeks|month|months|year|years)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unitRaw = m[2].toLowerCase();
  let unit: ParsedDuration['unit'];
  if (unitRaw.startsWith('day')) unit = 'days';
  else if (unitRaw.startsWith('week')) unit = 'weeks';
  else if (unitRaw.startsWith('month')) unit = 'months';
  else unit = 'years';
  return { n, unit, raw: value.trim() };
}

function subtractDuration(date: Date, d: ParsedDuration): Date {
  const result = new Date(date);
  if (d.unit === 'days') result.setDate(result.getDate() - d.n);
  else if (d.unit === 'weeks') result.setDate(result.getDate() - d.n * 7);
  else if (d.unit === 'months') result.setMonth(result.getMonth() - d.n);
  else result.setFullYear(result.getFullYear() - d.n);
  return result;
}

function addDuration(date: Date, d: ParsedDuration): Date {
  const result = new Date(date);
  if (d.unit === 'days') result.setDate(result.getDate() + d.n);
  else if (d.unit === 'weeks') result.setDate(result.getDate() + d.n * 7);
  else if (d.unit === 'months') result.setMonth(result.getMonth() + d.n);
  else result.setFullYear(result.getFullYear() + d.n);
  return result;
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function renderConstraintAsClaim(constraint: ConstraintLike, today: Date): string {
  const { type, field, value, value_secondary } = constraint;
  const strValue = value === null || value === undefined ? '' : String(value).trim();
  const rawOp = (constraint.operator ?? '').trim().toLowerCase();
  const op = rawOp.startsWith('not_') ? rawOp.slice(4) : rawOp;

  try {
    switch (type) {
      case 'text_compare': {
        switch (op) {
          case 'contains':    return `the ${field} contains '${strValue}'`;
          case 'starts_with': return `the ${field} starts with '${strValue}'`;
          case 'ends_with':   return `the ${field} ends with '${strValue}'`;
          case 'equals':      return `the ${field} is exactly '${strValue}'`;
          default:            return `the ${field} ${op} '${strValue}'`;
        }
      }

      case 'attribute_check': {
        switch (op) {
          case 'has':    return `they have ${strValue}`;
          case 'equals': return `their ${field} is ${strValue}`;
          default:       return `the ${field} ${op} ${strValue}`;
        }
      }

      case 'website_evidence': {
        switch (op) {
          case 'contains':
          case 'mentions':
            return `their website mentions or evidences ${strValue}`;
          default:
            return `the ${field} ${op} ${strValue}`;
        }
      }

      case 'relationship_check': {
        switch (op) {
          case 'has':           return `they have a relationship with ${strValue}`;
          case 'serves':        return `they serve ${strValue}`;
          case 'owned_by':      return `they are owned by ${strValue}`;
          case 'managed_by':    return `they are managed by ${strValue}`;
          case 'partners_with': return `they partner with ${strValue}`;
          default:              return `the ${field} ${op} ${strValue}`;
        }
      }

      case 'status_check': {
        switch (op) {
          case 'equals':
          case 'has':
            return `they are currently ${strValue}`;
          default:
            return `the ${field} ${op} ${strValue}`;
        }
      }

      case 'time_constraint': {
        switch (op) {
          case 'after': {
            const readable = readableDateWithIso(strValue);
            return `the ${field} is after ${readable}`;
          }
          case 'before': {
            const readable = readableDateWithIso(strValue);
            return `the ${field} is before ${readable}`;
          }
          case 'within_last': {
            const duration = parseDuration(strValue);
            if (duration) {
              const cutoff = subtractDuration(today, duration);
              const cutoffIso = toIso(cutoff);
              const cutoffReadable = readableDateWithIso(cutoffIso);
              return `the ${field} is within the last ${duration.raw}, i.e. on or after ${cutoffReadable}`;
            }
            return `the ${field} is within the last ${strValue}`;
          }
          case 'within_next': {
            const duration = parseDuration(strValue);
            if (duration) {
              const end = addDuration(today, duration);
              const endIso = toIso(end);
              const endReadable = readableDateWithIso(endIso);
              return `the ${field} is within the next ${duration.raw}, i.e. on or before ${endReadable}`;
            }
            return `the ${field} is within the next ${strValue}`;
          }
          case 'between_dates': {
            const startVal = strValue;
            const endVal = value_secondary !== null && value_secondary !== undefined
              ? String(value_secondary).trim()
              : '';
            const startReadable = readableDateWithIso(startVal);
            const endReadable = endVal ? readableDateWithIso(endVal) : '(unknown)';
            return `the ${field} is between ${startReadable} and ${endReadable}`;
          }
          case 'since': {
            return `the ${field} is in ${strValue} or later`;
          }
          default: {
            return `the ${field} ${op} ${strValue}`;
          }
        }
      }

      default: {
        return `the ${field} ${op} ${strValue}`;
      }
    }
  } catch {
    return `the ${field} ${op} ${strValue}`;
  }
}
