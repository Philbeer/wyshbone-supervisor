export type MissingField = 'location' | 'entity_type' | 'relationship_clarification';

export interface ClarifySession {
  conversationId: string;
  originalUserRequest: string;
  missingFields: MissingField[];
  collectedFields: {
    businessType: string | null;
    location: string | null;
    attribute: string | null;
    count: number | null;
    relationship: string | null;
  };
  createdAt: number;
}

export type FollowUpClass = 'ANSWER_TO_MISSING_FIELD' | 'REFINEMENT' | 'NEW_REQUEST';

export interface FollowUpResult {
  classification: FollowUpClass;
  updatedField?: MissingField;
  value?: string;
}

const sessions = new Map<string, ClarifySession>();

const SESSION_TTL_MS = 15 * 60 * 1000;

export function createClarifySession(
  conversationId: string,
  originalUserRequest: string,
  missingFields: MissingField[],
  initialFields: Partial<ClarifySession['collectedFields']>,
): ClarifySession {
  const session: ClarifySession = {
    conversationId,
    originalUserRequest,
    missingFields: [...missingFields],
    collectedFields: {
      businessType: initialFields.businessType ?? null,
      location: initialFields.location ?? null,
      attribute: initialFields.attribute ?? null,
      count: initialFields.count ?? null,
      relationship: initialFields.relationship ?? null,
    },
    createdAt: Date.now(),
  };
  sessions.set(conversationId, session);
  return session;
}

export function getClarifySession(conversationId: string): ClarifySession | null {
  const session = sessions.get(conversationId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(conversationId);
    return null;
  }
  return session;
}

export function closeClarifySession(conversationId: string): void {
  sessions.delete(conversationId);
}

const LOCATION_LIKE = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s*,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)?$/;
const KNOWN_LOCATIONS = /\b(?:UK|US|USA|England|Scotland|Wales|Ireland|London|Manchester|Birmingham|Bristol|Leeds|Sheffield|Liverpool|Newcastle|Edinburgh|Glasgow|Cardiff|Belfast|Sussex|East Sussex|West Sussex|Surrey|Kent|Essex|Devon|Cornwall|Norfolk|Suffolk|Yorkshire|Lancashire|Dorset|Hampshire|Somerset|Wiltshire|Berkshire|Oxfordshire|Cambridgeshire|Nottinghamshire|Derbyshire|Leicestershire|Warwickshire|Staffordshire|Shropshire|Herefordshire|Worcestershire|Gloucestershire|Lincolnshire|Rutland|Northamptonshire|Bedfordshire|Hertfordshire|Buckinghamshire|Middlesex|Merseyside|Tyneside|Blackpool|Brighton|Bath|Oxford|Cambridge|Exeter|Plymouth|Norwich|Nottingham|Leicester|Derby|Reading|Southampton|Portsmouth|York|Chester|Durham|Carlisle|Lancaster|Worcester|Gloucester|Lincoln|Ipswich|Colchester|Canterbury|Dover|Hastings|Eastbourne|Bournemouth|Poole|Swindon|Cheltenham|Coventry|Wolverhampton|Walsall|Dudley|Bolton|Stockport|Oldham|Rochdale|Blackburn|Burnley|Preston|Wigan|Warrington|Crewe|Stoke|Telford|Shrewsbury|Hereford|Berlin|Paris|Madrid|Barcelona|Rome|Milan|Amsterdam|Munich|Hamburg|Frankfurt|Vienna|Prague|Warsaw|Lisbon|Dublin|Brussels|Zurich|Geneva|Stockholm|Copenhagen|Oslo|Helsinki|Athens|Budapest|Bucharest|Zagreb|Ljubljana|Bratislava|Tallinn|Riga|Vilnius|New York|Los Angeles|Chicago|Houston|Phoenix|Philadelphia|San Antonio|San Diego|Dallas|San Jose|Austin|Jacksonville|San Francisco|Seattle|Denver|Boston|Nashville|Portland|Las Vegas|Memphis|Louisville|Baltimore|Milwaukee|Albuquerque|Tucson|Fresno|Sacramento|Mesa|Atlanta|Kansas City|Colorado Springs|Omaha|Raleigh|Miami|Cleveland|Tampa|Minneapolis|Orlando|St Louis|Pittsburgh|Cincinnati|Greensboro|Newark|Toledo|Henderson|Plano|Lincoln|Buffalo|Jersey City|Chandler|Chula Vista|Madison|Lubbock|Scottsdale|Glendale|Reno|Norfolk|Winston-Salem|North Las Vegas|Irving|Chesapeake|Gilbert|Hialeah|Garland|Fremont|Baton Rouge|Richmond)\b/i;

const QUESTION_PATTERNS = [
  /^(?:what|how|why|who|when|where|which|is|are|do|does|can|could|would|should|will|have|has)\b/i,
  /\?$/,
];

const NEW_REQUEST_SIGNALS = [
  /\b(?:can you|could you|would you|help me|i need|i want|i'd like)\b/i,
  /\b(?:find|search|list|show|get|look\s+for|locate|discover|identify)\b.*\b(?:in|near|around|across)\b/i,
  /\b(?:sales|marketing|pricing|billing|account|subscription|refund|cancel|support)\b/i,
  /\b(?:guarantee|guaranteed|accurate|correct|reliable|trust|confident|sure)\b/i,
];

const REFINEMENT_LIKE = /^[a-z\s-]+$/i;
const BUSINESS_MODIFIERS = /\b(?:free\s*houses?|gastropubs?|wine\s*bars?|cocktail\s*bars?|sports?\s*bars?|craft\s*beer|real\s*ale|micro\s*pubs?|tap\s*rooms?|beer\s*gardens?|dog\s*friendly|family\s*friendly|live\s*music|food\s*served|cask\s*ale|independent|chain|premium|budget|organic|vegan|vegetarian|gluten\s*free|halal|kosher)\b/i;

function looksLikeLocation(msg: string): boolean {
  const trimmed = msg.trim();
  if (KNOWN_LOCATIONS.test(trimmed)) return true;
  if (LOCATION_LIKE.test(trimmed) && trimmed.split(/\s+/).length <= 4) return true;
  return false;
}

function isShortFieldAnswer(msg: string, session: ClarifySession): boolean {
  const stripped = msg.replace(/[?!.,]+$/, '').trim();
  const wordCount = stripped.split(/\s+/).length;
  if (wordCount > 5) return false;

  if (session.missingFields.includes('location') && looksLikeLocation(stripped)) return true;
  if (session.missingFields.includes('entity_type') && wordCount <= 3) return true;
  if (session.missingFields.includes('relationship_clarification')) {
    if (/\b(?:yes|yeah|yep|sure|ok|okay|go ahead|just|any|fine|proceed|do it)\b/i.test(stripped)) return true;
  }

  return false;
}

function looksLikeNewRequest(msg: string, session: ClarifySession): boolean {
  const trimmed = msg.trim();

  if (isShortFieldAnswer(trimmed, session)) return false;

  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      const hasSearchVerb = /\b(?:find|search|list|show|get|look\s+for|locate)\b/i.test(trimmed);
      if (!hasSearchVerb) return true;
    }
  }

  for (const pattern of NEW_REQUEST_SIGNALS) {
    if (pattern.test(trimmed)) {
      const isLocationAnswer = session.missingFields.includes('location') && looksLikeLocation(trimmed);
      if (!isLocationAnswer) return true;
    }
  }

  if (trimmed.split(/\s+/).length > 10) {
    const hasSearchVerb = /\b(?:find|search|list|show|get|look\s+for|locate)\b/i.test(trimmed);
    if (hasSearchVerb) return true;
  }

  return false;
}

function looksLikeRefinement(msg: string): boolean {
  const trimmed = msg.trim();
  if (trimmed.split(/\s+/).length > 5) return false;
  if (BUSINESS_MODIFIERS.test(trimmed)) return true;
  if (REFINEMENT_LIKE.test(trimmed) && trimmed.split(/\s+/).length <= 3) return true;
  return false;
}

export function classifyFollowUp(msg: string, session: ClarifySession): FollowUpResult {
  const trimmed = msg.trim();
  const stripped = trimmed.replace(/[?!.,]+$/, '').trim();

  if (looksLikeNewRequest(trimmed, session)) {
    return { classification: 'NEW_REQUEST' };
  }

  if (session.missingFields.includes('location') && (looksLikeLocation(trimmed) || looksLikeLocation(stripped))) {
    return {
      classification: 'ANSWER_TO_MISSING_FIELD',
      updatedField: 'location',
      value: stripped,
    };
  }

  if (session.missingFields.includes('entity_type')) {
    if (trimmed.split(/\s+/).length <= 5 && !looksLikeLocation(trimmed)) {
      return {
        classification: 'ANSWER_TO_MISSING_FIELD',
        updatedField: 'entity_type',
        value: trimmed,
      };
    }
  }

  if (session.missingFields.includes('relationship_clarification')) {
    const lower = trimmed.toLowerCase();
    if (/\b(?:yes|yeah|yep|sure|ok|okay|go ahead|just|any|research|proceed|do it|that's fine|fine)\b/i.test(lower)) {
      return {
        classification: 'ANSWER_TO_MISSING_FIELD',
        updatedField: 'relationship_clarification',
        value: trimmed,
      };
    }
  }

  if (looksLikeRefinement(trimmed)) {
    return {
      classification: 'REFINEMENT',
      value: trimmed,
    };
  }

  if (trimmed.split(/\s+/).length <= 3 && !looksLikeNewRequest(trimmed, session)) {
    if (session.missingFields.includes('location')) {
      return {
        classification: 'ANSWER_TO_MISSING_FIELD',
        updatedField: 'location',
        value: trimmed,
      };
    }
    return {
      classification: 'REFINEMENT',
      value: trimmed,
    };
  }

  return { classification: 'NEW_REQUEST' };
}

export function applyFollowUp(session: ClarifySession, result: FollowUpResult): void {
  if (result.classification === 'ANSWER_TO_MISSING_FIELD' && result.updatedField && result.value) {
    if (result.updatedField === 'location') {
      session.collectedFields.location = result.value;
    } else if (result.updatedField === 'entity_type') {
      session.collectedFields.businessType = result.value;
    } else if (result.updatedField === 'relationship_clarification') {
      session.collectedFields.relationship = result.value;
    }
    session.missingFields = session.missingFields.filter(f => f !== result.updatedField);
  } else if (result.classification === 'REFINEMENT' && result.value) {
    if (BUSINESS_MODIFIERS.test(result.value)) {
      session.collectedFields.attribute = result.value;
    } else {
      if (session.collectedFields.businessType) {
        session.collectedFields.attribute = result.value;
      } else {
        session.collectedFields.businessType = result.value;
      }
    }
  }
}

export function renderClarifySummary(session: ClarifySession): string {
  const parts: string[] = [];

  const bt = session.collectedFields.businessType;
  if (bt) parts.push(bt);

  const loc = session.collectedFields.location;
  if (loc) parts.push(`in ${loc}`);

  const attr = session.collectedFields.attribute;
  if (attr) parts.push(`(${attr})`);

  const count = session.collectedFields.count;
  if (count) parts.unshift(`${count}`);

  if (parts.length === 0) return session.originalUserRequest;
  return `Find ${parts.join(' ')}`;
}

export function sessionIsComplete(session: ClarifySession): boolean {
  if (session.missingFields.length > 0) return false;
  if (!session.collectedFields.businessType && !session.collectedFields.relationship) return false;
  return true;
}

export function buildSearchFromSession(session: ClarifySession): { businessType: string; location: string; attribute: string | null; count: number | null } {
  return {
    businessType: session.collectedFields.businessType || 'businesses',
    location: session.collectedFields.location || 'Local',
    attribute: session.collectedFields.attribute,
    count: session.collectedFields.count,
  };
}
