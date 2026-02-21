import { buildToolResult, buildToolError, evidencedValue, unknownValue } from "@shared/tool-result-helpers";
import type { ToolResultEnvelope, EvidenceItem, EvidencedValue, UnknownValue } from "@shared/tool-result";

const TOOL_NAME = "LEAD_ENRICH";
const TOOL_VERSION = "1.0";

type SignalValue = EvidencedValue<boolean> | UnknownValue;

interface LeadIdentity {
  name: string;
  place_id?: string;
  formatted_address?: string;
  lat?: number;
  lng?: number;
  types?: string[];
  website?: string;
  phone?: string;
}

interface ContactEntry {
  value: string;
  verified: boolean;
  evidence: EvidenceItem[];
  source_type: "official_site" | "places" | "directory" | "unknown";
}

interface LeadContacts {
  emails: ContactEntry[];
  phones: ContactEntry[];
  social?: {
    facebook?: string;
    instagram?: string;
    x?: string;
    linkedin?: string;
  };
  contact_page_url?: string;
  contact_form_url?: string;
  people?: {
    name: string;
    role: string;
    context: string;
    verified: boolean;
    evidence_url: string;
  }[];
}

interface LeadSignals {
  live_music: SignalValue;
  food: SignalValue;
  events: SignalValue;
  booking: SignalValue;
}

interface LeadPackOutput {
  identity: LeadIdentity;
  contacts: LeadContacts;
  signals: LeadSignals;
  source_priority: string[];
  notes: string[];
  confidence: number;
}

export interface LeadEnrichInput {
  places_lead?: {
    place_id?: string;
    name: string;
    formatted_address?: string;
    lat?: number;
    lng?: number;
    types?: string[];
    website?: string;
    phone?: string;
  } | null;
  web_visit_pages?: {
    url: string;
    text_clean: string;
    page_type?: string;
  }[] | null;
  contact_extract?: {
    contacts?: {
      emails?: string[];
      phones?: string[];
      social?: {
        facebook?: string;
        instagram?: string;
        x?: string;
        linkedin?: string;
      };
      contact_page_url?: string;
      contact_form_url?: string;
    };
    people?: {
      name: string;
      role: string;
      context: string;
      verified: boolean;
      evidence_url: string;
    }[];
  } | null;
  ask_lead_question_result?: {
    question: string;
    answer: string;
    source_url?: string;
  } | null;
  web_search?: {
    results?: { url: string; title?: string; snippet?: string }[];
    outputs?: {
      results?: { url: string; title?: string; snippet?: string }[];
    };
  } | null;
}

const SOURCE_PRIORITY = ["places", "official_site", "directory", "social"];

const LIVE_MUSIC_KEYWORDS = [
  "live music", "live band", "live entertainment", "acoustic",
  "open mic", "gig", "dj set", "karaoke", "music venue",
];

const FOOD_KEYWORDS = [
  "menu", "food", "kitchen", "restaurant", "dining",
  "breakfast", "lunch", "dinner", "chef", "cuisine",
  "gastropub", "bistro", "food served",
];

const EVENTS_KEYWORDS = [
  "events", "event", "what's on", "whats on", "calendar",
  "upcoming", "function room", "private hire", "party",
  "wedding", "celebration", "quiz night", "pub quiz",
];

const BOOKING_KEYWORDS = [
  "book", "booking", "reserve", "reservation",
  "book a table", "book online", "opentable", "resdiary",
  "designmynight",
];

function normaliseDomain(raw: string): string {
  try {
    const u = new URL(raw);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function isOfficialSitePage(
  pageUrl: string,
  officialWebsite: string | undefined,
): boolean {
  if (!officialWebsite) return false;
  return normaliseDomain(pageUrl) === normaliseDomain(officialWebsite);
}

function detectSignal(
  keywords: string[],
  pages: { url: string; text_clean: string }[],
  fieldName: string,
): { signal: SignalValue; evidence?: EvidenceItem } {
  for (const page of pages) {
    const textLower = page.text_clean.toLowerCase();
    for (const kw of keywords) {
      const idx = textLower.indexOf(kw);
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        const end = Math.min(textLower.length, idx + kw.length + 50);
        const quote = page.text_clean.substring(start, end).trim();

        const ev: EvidenceItem = {
          source_type: "website",
          source_url: page.url,
          captured_at: new Date().toISOString(),
          quote: `Keyword "${kw}" found: ...${quote}...`,
          field_supported: `signals.${fieldName}`,
        };

        return {
          signal: evidencedValue(true, ev),
          evidence: ev,
        };
      }
    }
  }

  return {
    signal: unknownValue(`No evidence found in ${pages.length} page(s) for ${fieldName}`),
  };
}

function detectSignalFromTypes(
  types: string[],
  signalField: string,
  matchTypes: string[],
  sourceUrl: string,
): { signal: SignalValue; evidence?: EvidenceItem } | null {
  const typesLower = types.map((t) => t.toLowerCase());
  for (const mt of matchTypes) {
    if (typesLower.includes(mt.toLowerCase())) {
      const ev: EvidenceItem = {
        source_type: "places",
        source_url: sourceUrl,
        captured_at: new Date().toISOString(),
        quote: `Google Places type includes "${mt}"`,
        field_supported: `signals.${signalField}`,
      };
      return { signal: evidencedValue(true, ev), evidence: ev };
    }
  }
  return null;
}

const UK_PHONE_RE = /(?:\+44\s?|0)\d[\d\s]{8,12}\d/g;
const INTL_PHONE_RE = /\+\d[\d\s\-]{7,15}\d/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function extractPhonesFromText(text: string): string[] {
  const ukMatches = text.match(UK_PHONE_RE) ?? [];
  const intlMatches = text.match(INTL_PHONE_RE) ?? [];
  const all = [...ukMatches, ...intlMatches];
  const normalised = all.map((p) => p.replace(/[\s\-]/g, ""));
  return Array.from(new Set(normalised));
}

function extractEmailsFromText(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? [];
  const lowered = matches.map((e) => e.toLowerCase());
  return Array.from(new Set(lowered));
}

function getWebSearchResults(
  ws: LeadEnrichInput["web_search"],
): { url: string; title?: string; snippet?: string }[] {
  if (!ws) return [];
  if (Array.isArray(ws.results) && ws.results.length > 0) return ws.results;
  if (ws.outputs && Array.isArray(ws.outputs.results) && ws.outputs.results.length > 0) return ws.outputs.results;
  return [];
}

export function executeLeadEnrich(
  input: LeadEnrichInput,
  runId: string,
  goalId?: string,
): ToolResultEnvelope {
  const place = input.places_lead;
  const pages = input.web_visit_pages ?? [];
  const contactData = input.contact_extract;
  const qlResult = input.ask_lead_question_result;

  const wsResults = getWebSearchResults(input.web_search);
  if (!place && pages.length === 0 && !contactData && wsResults.length === 0) {
    return buildToolResult({
      tool_name: TOOL_NAME,
      tool_version: TOOL_VERSION,
      run_id: runId,
      goal_id: goalId,
      inputs: { has_places: false, has_pages: false, has_contacts: false, has_web_search: false },
      outputs: {},
      errors: [buildToolError("NO_DATA", "At least one data source (places_lead, web_visit_pages, contact_extract, or web_search) is required", false)],
    });
  }

  const evidence: EvidenceItem[] = [];
  const notes: string[] = [];
  const usedSources: string[] = [];

  const identity: LeadIdentity = {
    name: place?.name ?? "Unknown",
  };

  if (place) {
    usedSources.push("places");
    const placesUrl = `https://maps.google.com/?cid=${place.place_id ?? "unknown"}`;
    const now = new Date().toISOString();

    if (place.place_id) identity.place_id = place.place_id;

    evidence.push({
      source_type: "places",
      source_url: placesUrl,
      captured_at: now,
      quote: `Name: ${place.name}`,
      field_supported: "identity.name",
    });

    if (place.formatted_address) {
      identity.formatted_address = place.formatted_address;
      evidence.push({
        source_type: "places",
        source_url: placesUrl,
        captured_at: now,
        quote: `Address: ${place.formatted_address}`,
        field_supported: "identity.formatted_address",
      });
    }
    if (place.lat != null && place.lng != null) {
      identity.lat = place.lat;
      identity.lng = place.lng;
      evidence.push({
        source_type: "places",
        source_url: placesUrl,
        captured_at: now,
        quote: `Coordinates: ${place.lat}, ${place.lng}`,
        field_supported: "identity.lat_lng",
      });
    }
    if (place.types) {
      identity.types = place.types;
      evidence.push({
        source_type: "places",
        source_url: placesUrl,
        captured_at: now,
        quote: `Types: ${place.types.join(", ")}`,
        field_supported: "identity.types",
      });
    }
    if (place.website) {
      identity.website = place.website;
      evidence.push({
        source_type: "places",
        source_url: placesUrl,
        captured_at: now,
        quote: `Website: ${place.website}`,
        field_supported: "identity.website",
      });
    }
    if (place.phone) {
      identity.phone = place.phone;
      evidence.push({
        source_type: "places",
        source_url: placesUrl,
        captured_at: now,
        quote: `Phone: ${place.phone}`,
        field_supported: "identity.phone",
      });
    }
  }

  if (pages.length > 0) {
    usedSources.push("official_site");
    notes.push(`${pages.length} page(s) crawled from website`);
  }

  const officialWebsite = place?.website;

  interface ContactTracking {
    evidenceItems: EvidenceItem[];
    nonOfficialWebDomains: Set<string>;
    onOfficialSite: boolean;
    fromPlaces: boolean;
  }

  const emailMap = new Map<string, ContactTracking>();
  const phoneMap = new Map<string, ContactTracking>();

  function trackContactEntry(
    map: Map<string, ContactTracking>,
    value: string,
    ev: EvidenceItem,
    sourceUrl: string,
    isPlacesSource: boolean,
  ) {
    if (!map.has(value)) {
      map.set(value, { evidenceItems: [], nonOfficialWebDomains: new Set(), onOfficialSite: false, fromPlaces: false });
    }
    const entry = map.get(value)!;
    entry.evidenceItems.push(ev);

    if (isPlacesSource) {
      entry.fromPlaces = true;
    } else if (isOfficialSitePage(sourceUrl, officialWebsite)) {
      entry.onOfficialSite = true;
    } else {
      entry.nonOfficialWebDomains.add(normaliseDomain(sourceUrl));
    }
  }

  function buildContactEntry(
    value: string,
    data: ContactTracking,
  ): ContactEntry {
    if (data.onOfficialSite) {
      return { value, verified: true, evidence: data.evidenceItems, source_type: "official_site" };
    }
    if (data.nonOfficialWebDomains.size >= 2) {
      return { value, verified: true, evidence: data.evidenceItems, source_type: "directory" };
    }
    const sourceType = data.fromPlaces ? "places" as const : "unknown" as const;
    return { value, verified: false, evidence: data.evidenceItems, source_type: sourceType };
  }

  const contacts: LeadContacts = {
    emails: [],
    phones: [],
  };

  if (contactData?.contacts) {
    usedSources.push("directory");
    const c = contactData.contacts;
    if (c.emails?.length) {
      for (const email of c.emails) {
        const sourceUrl = c.contact_page_url ?? pages[0]?.url ?? "unknown";
        const ev: EvidenceItem = {
          source_type: "website",
          source_url: sourceUrl,
          captured_at: new Date().toISOString(),
          quote: `Email: ${email}`,
          field_supported: "contacts.emails",
        };
        evidence.push(ev);
        trackContactEntry(emailMap, email, ev, sourceUrl, false);
      }
    }
    if (c.phones?.length) {
      const phoneSource = c.contact_page_url ?? pages[0]?.url ?? "unknown";
      for (const phone of c.phones) {
        const ev: EvidenceItem = {
          source_type: "website",
          source_url: phoneSource,
          captured_at: new Date().toISOString(),
          quote: `Phone: ${phone}`,
          field_supported: "contacts.phones",
        };
        evidence.push(ev);
        trackContactEntry(phoneMap, phone, ev, phoneSource, false);
      }
    }
    if (c.social && Object.keys(c.social).length > 0) {
      contacts.social = { ...c.social };
      const socialSource = pages[0]?.url ?? "unknown";
      for (const [key, value] of Object.entries(c.social)) {
        if (value) {
          evidence.push({
            source_type: "social",
            source_url: value,
            captured_at: new Date().toISOString(),
            quote: `Social link (${key}): ${value}`,
            field_supported: `contacts.social.${key}`,
          });
        }
      }
    }
    if (c.contact_page_url) {
      contacts.contact_page_url = c.contact_page_url;
      evidence.push({
        source_type: "website",
        source_url: c.contact_page_url,
        captured_at: new Date().toISOString(),
        quote: `Contact page: ${c.contact_page_url}`,
        field_supported: "contacts.contact_page_url",
      });
    }
    if (c.contact_form_url) {
      contacts.contact_form_url = c.contact_form_url;
      evidence.push({
        source_type: "website",
        source_url: c.contact_form_url,
        captured_at: new Date().toISOString(),
        quote: `Contact form page: ${c.contact_form_url}`,
        field_supported: "contacts.contact_form_url",
      });
    }
  }

  if (contactData?.people?.length) {
    contacts.people = contactData.people.map((p) => ({ ...p }));
    for (const person of contactData.people) {
      evidence.push({
        source_type: "website",
        source_url: person.evidence_url,
        captured_at: new Date().toISOString(),
        quote: `Person: ${person.name}, Role: ${person.role}`,
        field_supported: "contacts.people",
      });
    }
  }

  if (place?.phone) {
    const placesUrl = `https://maps.google.com/?cid=${place.place_id ?? "unknown"}`;
    const ev: EvidenceItem = {
      source_type: "places",
      source_url: placesUrl,
      captured_at: new Date().toISOString(),
      quote: `Phone from Places: ${place.phone}`,
      field_supported: "contacts.phones",
    };
    evidence.push(ev);
    trackContactEntry(phoneMap, place.phone, ev, placesUrl, true);
  }

  const searchResults = getWebSearchResults(input.web_search);
  if (searchResults.length > 0) {
    const phonesAlreadyHaveOfficialOrExtracted = Array.from(phoneMap.values()).some((t) => t.onOfficialSite);
    const emailsAlreadyHaveOfficialOrExtracted = Array.from(emailMap.values()).some((t) => t.onOfficialSite);

    for (const result of searchResults) {
      if (!result.url || !result.snippet) continue;
      const textToScan = `${result.title ?? ""} ${result.snippet}`;
      const phones = extractPhonesFromText(textToScan);
      const emails = extractEmailsFromText(textToScan);
      const now = new Date().toISOString();

      for (const phone of phones) {
        if (phonesAlreadyHaveOfficialOrExtracted && phoneMap.has(phone) && phoneMap.get(phone)!.onOfficialSite) continue;
        const snippetFragment = result.snippet!.length > 200 ? result.snippet!.substring(0, 200) + "…" : result.snippet!;
        const ev: EvidenceItem = {
          source_type: "search_result",
          source_url: result.url,
          captured_at: now,
          quote: `Phone "${phone}" found in search snippet: ${snippetFragment}`,
          field_supported: "contacts.phones",
        };
        evidence.push(ev);
        trackContactEntry(phoneMap, phone, ev, result.url, false);
      }

      for (const email of emails) {
        if (emailsAlreadyHaveOfficialOrExtracted && emailMap.has(email) && emailMap.get(email)!.onOfficialSite) continue;
        const snippetFragment = result.snippet!.length > 200 ? result.snippet!.substring(0, 200) + "…" : result.snippet!;
        const ev: EvidenceItem = {
          source_type: "search_result",
          source_url: result.url,
          captured_at: now,
          quote: `Email "${email}" found in search snippet: ${snippetFragment}`,
          field_supported: "contacts.emails",
        };
        evidence.push(ev);
        trackContactEntry(emailMap, email, ev, result.url, false);
      }
    }

    if (searchResults.length > 0 && !usedSources.includes("directory")) {
      usedSources.push("directory");
    }
    const phonesFromSearch = Array.from(phoneMap.values()).filter((t) => t.nonOfficialWebDomains.size > 0).length;
    const emailsFromSearch = Array.from(emailMap.values()).filter((t) => t.nonOfficialWebDomains.size > 0).length;
    if (phonesFromSearch > 0 || emailsFromSearch > 0) {
      notes.push(`Extracted ${phonesFromSearch} phone(s), ${emailsFromSearch} email(s) from ${searchResults.length} web search snippet(s)`);
    }
  }

  for (const [value, data] of Array.from(emailMap.entries())) {
    contacts.emails.push(buildContactEntry(value, data));
  }
  for (const [value, data] of Array.from(phoneMap.entries())) {
    contacts.phones.push(buildContactEntry(value, data));
  }

  const placeTypes = place?.types ?? [];
  const placeUrl = place?.website ?? `https://maps.google.com/?cid=${place?.place_id ?? "unknown"}`;

  let liveMusicResult = detectSignal(LIVE_MUSIC_KEYWORDS, pages, "live_music");
  if (!("verified" in liveMusicResult.signal && liveMusicResult.signal.verified)) {
    const fromTypes = detectSignalFromTypes(placeTypes, "live_music", ["night_club", "bar"], placeUrl);
    if (fromTypes) liveMusicResult = fromTypes;
  }

  let foodResult = detectSignal(FOOD_KEYWORDS, pages, "food");
  if (!("verified" in foodResult.signal && foodResult.signal.verified)) {
    const fromTypes = detectSignalFromTypes(placeTypes, "food", ["restaurant", "meal_takeaway", "meal_delivery", "bakery", "cafe"], placeUrl);
    if (fromTypes) foodResult = fromTypes;
  }

  let eventsResult = detectSignal(EVENTS_KEYWORDS, pages, "events");

  let bookingResult = detectSignal(BOOKING_KEYWORDS, pages, "booking");

  const signals: LeadSignals = {
    live_music: liveMusicResult.signal,
    food: foodResult.signal,
    events: eventsResult.signal,
    booking: bookingResult.signal,
  };

  if (liveMusicResult.evidence) evidence.push(liveMusicResult.evidence);
  if (foodResult.evidence) evidence.push(foodResult.evidence);
  if (eventsResult.evidence) evidence.push(eventsResult.evidence);
  if (bookingResult.evidence) evidence.push(bookingResult.evidence);

  const signalEntries: [string, SignalValue][] = [
    ["live_music", signals.live_music],
    ["food", signals.food],
    ["events", signals.events],
    ["booking", signals.booking],
  ];
  for (const [name, sig] of signalEntries) {
    if ("reason" in sig && sig.value === null) {
      const label = name.replace(/_/g, " ");
      if (pages.length === 0 && !place) {
        notes.push(`${label}: unknown — no website or Places data available to check`);
      } else if (pages.length === 0) {
        notes.push(`${label}: unknown — no website pages were crawled (site may be missing or blocked)`);
      } else {
        notes.push(`${label}: unknown — no matching evidence found in ${pages.length} crawled page(s)`);
      }
    }
  }

  const sourceLabels: Record<string, string> = {
    places: "Google Places",
    official_site: "official website (via crawl)",
    directory: "third-party directories / search results",
    social: "social media profiles",
  };
  const orderedSources = SOURCE_PRIORITY.filter((s) => usedSources.includes(s));
  if (orderedSources.length > 0) {
    const readable = orderedSources.map((s) => sourceLabels[s] ?? s).join(", then ");
    notes.push(`Sources used (priority order): ${readable}`);
  } else {
    notes.push("Sources used: none — no data sources were available");
  }

  if (qlResult) {
    notes.push(`Q: ${qlResult.question} → A: ${qlResult.answer}`);
    if (qlResult.source_url) {
      evidence.push({
        source_type: "website",
        source_url: qlResult.source_url,
        captured_at: new Date().toISOString(),
        quote: `Lead question answer: ${qlResult.answer.substring(0, 200)}`,
        field_supported: "notes",
      });
    }
  }

  let confidenceScore = 0;
  if (place) confidenceScore += 0.3;
  if (pages.length > 0) confidenceScore += 0.2;
  if (contacts.emails.length > 0) confidenceScore += 0.15;
  if (contacts.phones.length > 0) confidenceScore += 0.1;
  if (contacts.social && Object.keys(contacts.social).length > 0) confidenceScore += 0.05;
  const verifiedSignalCount = Object.values(signals).filter(
    (s) => "verified" in s && s.verified === true,
  ).length;
  confidenceScore += verifiedSignalCount * 0.05;
  confidenceScore = Math.min(1, confidenceScore);

  const leadPack: LeadPackOutput = {
    identity,
    contacts,
    signals,
    source_priority: SOURCE_PRIORITY.filter((s) => usedSources.includes(s)),
    notes,
    confidence: Math.round(confidenceScore * 100) / 100,
  };

  return buildToolResult({
    tool_name: TOOL_NAME,
    tool_version: TOOL_VERSION,
    run_id: runId,
    goal_id: goalId,
    inputs: {
      has_places: !!place,
      has_pages: pages.length > 0,
      has_contacts: !!contactData,
      has_question: !!qlResult,
      entity_name: place?.name ?? null,
    },
    outputs: { lead_pack: leadPack } as unknown as Record<string, unknown>,
    evidence,
    confidence: confidenceScore,
  });
}
