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

interface LeadContacts {
  emails: string[];
  phones: string[];
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

export function executeLeadEnrich(
  input: LeadEnrichInput,
  runId: string,
  goalId?: string,
): ToolResultEnvelope {
  const place = input.places_lead;
  const pages = input.web_visit_pages ?? [];
  const contactData = input.contact_extract;
  const qlResult = input.ask_lead_question_result;

  if (!place && pages.length === 0 && !contactData) {
    return buildToolResult({
      tool_name: TOOL_NAME,
      tool_version: TOOL_VERSION,
      run_id: runId,
      goal_id: goalId,
      inputs: { has_places: false, has_pages: false, has_contacts: false },
      outputs: {},
      errors: [buildToolError("NO_DATA", "At least one data source (places_lead, web_visit_pages, or contact_extract) is required", false)],
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

  const contacts: LeadContacts = {
    emails: [],
    phones: [],
  };

  if (contactData?.contacts) {
    usedSources.push("directory");
    const c = contactData.contacts;
    if (c.emails?.length) {
      contacts.emails = [...c.emails];
      for (const email of c.emails) {
        evidence.push({
          source_type: "website",
          source_url: c.contact_page_url ?? pages[0]?.url ?? "unknown",
          captured_at: new Date().toISOString(),
          quote: `Email: ${email}`,
          field_supported: "contacts.emails",
        });
      }
    }
    if (c.phones?.length) {
      contacts.phones = [...c.phones];
      const phoneSource = c.contact_page_url ?? pages[0]?.url ?? "unknown";
      for (const phone of c.phones) {
        evidence.push({
          source_type: "website",
          source_url: phoneSource,
          captured_at: new Date().toISOString(),
          quote: `Phone: ${phone}`,
          field_supported: "contacts.phones",
        });
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

  if (place?.phone && !contacts.phones.includes(place.phone)) {
    contacts.phones.unshift(place.phone);
    evidence.push({
      source_type: "places",
      source_url: `https://maps.google.com/?cid=${place.place_id ?? "unknown"}`,
      captured_at: new Date().toISOString(),
      quote: `Phone from Places: ${place.phone}`,
      field_supported: "contacts.phones",
    });
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

  const outputs: LeadPackOutput = {
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
    outputs: outputs as unknown as Record<string, unknown>,
    evidence,
    confidence: confidenceScore,
  });
}
