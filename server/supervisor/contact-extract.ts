import { buildToolResult, buildToolError } from "@shared/tool-result-helpers";
import type { ToolResultEnvelope, EvidenceItem } from "@shared/tool-result";

const TOOL_NAME = "CONTACT_EXTRACT";
const TOOL_VERSION = "1.0";

export interface ContactExtractInput {
  pages: { url: string; text_clean: string }[];
  entity_name?: string | null;
}

interface PersonEntry {
  name: string;
  role: string;
  context: string;
  verified: boolean;
  evidence_url: string;
}

interface SocialLinks {
  facebook?: string;
  instagram?: string;
  x?: string;
  linkedin?: string;
}

interface ContactsOutput {
  emails: string[];
  phones: string[];
  contact_page_url?: string;
  contact_form_url?: string;
  social?: SocialLinks;
}

interface ContactExtractOutput {
  contacts: ContactsOutput;
  people: PersonEntry[];
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const PHONE_REGEX = /(?:\+?\d{1,4}[\s\-.]?)?\(?\d{2,5}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}/g;

const PHONE_MIN_DIGITS = 7;
const PHONE_MAX_DIGITS = 15;

const MAILTO_REGEX = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
const TEL_REGEX = /tel:([\+\d\s\-().]+)/g;

const SOCIAL_PATTERNS: { key: keyof SocialLinks; regex: RegExp }[] = [
  { key: "facebook", regex: /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9._\-]+\/?/g },
  { key: "instagram", regex: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9._\-]+\/?/g },
  { key: "x", regex: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[a-zA-Z0-9._\-]+\/?/g },
  { key: "linkedin", regex: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[a-zA-Z0-9._\-]+\/?/g },
];

const CONTACT_PAGE_KEYWORDS = ["/contact", "/contact-us", "/get-in-touch", "/reach-us"];
const CONTACT_FORM_KEYWORDS = ["contact form", "get in touch", "send us a message", "enquiry form", "inquiry form"];

const IGNORED_EMAIL_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /donotreply@/i,
  /example\.com$/i,
  /sentry\.io$/i,
  /wixpress\.com$/i,
  /placeholder/i,
];

const ROLE_PATTERNS = [
  "owner", "manager", "director", "chef", "head chef", "founder", "co-founder",
  "ceo", "cto", "cfo", "coo", "president", "vice president", "vp",
  "landlord", "landlady", "licensee", "proprietor",
  "general manager", "operations manager", "marketing manager",
  "partner", "managing director", "head of", "lead",
];

const NAME_REGEX = /[A-Z][a-z]+(?:\s[A-Z][a-z]+)+/g;

function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  for (const pattern of IGNORED_EMAIL_PATTERNS) {
    if (pattern.test(email)) return false;
  }
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const domain = parts[1];
  if (!domain.includes(".")) return false;
  const tld = domain.split(".").pop() || "";
  if (tld.length < 2) return false;
  return true;
}

function isValidPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS;
}

function normalizePhone(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function extractEmails(text: string): string[] {
  const found = new Set<string>();

  let match: RegExpExecArray | null;
  const mailtoRegex = new RegExp(MAILTO_REGEX.source, "g");
  while ((match = mailtoRegex.exec(text)) !== null) {
    const email = match[1].toLowerCase();
    if (isValidEmail(email)) found.add(email);
  }

  const emailRegex = new RegExp(EMAIL_REGEX.source, "g");
  while ((match = emailRegex.exec(text)) !== null) {
    const email = match[0].toLowerCase();
    if (isValidEmail(email)) found.add(email);
  }

  return Array.from(found);
}

function extractPhones(text: string): string[] {
  const found = new Set<string>();

  let match: RegExpExecArray | null;
  const telRegex = new RegExp(TEL_REGEX.source, "g");
  while ((match = telRegex.exec(text)) !== null) {
    const phone = normalizePhone(match[1]);
    if (isValidPhone(phone)) found.add(phone);
  }

  const phoneRegex = new RegExp(PHONE_REGEX.source, "g");
  while ((match = phoneRegex.exec(text)) !== null) {
    const phone = normalizePhone(match[0]);
    if (isValidPhone(phone)) found.add(phone);
  }

  return Array.from(found);
}

function extractSocial(text: string): SocialLinks {
  const social: SocialLinks = {};
  for (const { key, regex } of SOCIAL_PATTERNS) {
    const pattern = new RegExp(regex.source, "g");
    const match = pattern.exec(text);
    if (match) {
      social[key] = match[0].replace(/\/$/, "");
    }
  }
  return social;
}

function detectContactPage(pageUrl: string): boolean {
  const lower = pageUrl.toLowerCase();
  return CONTACT_PAGE_KEYWORDS.some((kw) => lower.includes(kw));
}

function detectContactForm(text: string): boolean {
  const lower = text.toLowerCase();
  return CONTACT_FORM_KEYWORDS.some((kw) => lower.includes(kw));
}

function extractPeople(text: string, pageUrl: string): PersonEntry[] {
  const people: PersonEntry[] = [];
  const lines = text.split("\n");
  const seenNames = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lowerLine = line.toLowerCase();

    for (const role of ROLE_PATTERNS) {
      if (!lowerLine.includes(role)) continue;

      const nameRegex = new RegExp(NAME_REGEX.source, "g");
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = nameRegex.exec(line)) !== null) {
        const name = nameMatch[0];
        if (name.split(" ").length < 2) continue;
        if (name.split(" ").length > 4) continue;
        if (seenNames.has(name.toLowerCase())) continue;

        const contextStart = Math.max(0, i - 1);
        const contextEnd = Math.min(lines.length, i + 2);
        const context = lines.slice(contextStart, contextEnd).join(" ").substring(0, 200);

        seenNames.add(name.toLowerCase());
        people.push({
          name,
          role: role.charAt(0).toUpperCase() + role.slice(1),
          context,
          verified: true,
          evidence_url: pageUrl,
        });
        break;
      }
    }
  }

  return people;
}

export function executeContactExtract(
  input: ContactExtractInput,
  runId: string,
  goalId?: string,
): ToolResultEnvelope {
  const pages = input.pages || [];

  if (pages.length === 0) {
    return buildToolResult({
      tool_name: TOOL_NAME,
      tool_version: TOOL_VERSION,
      run_id: runId,
      goal_id: goalId,
      inputs: { entity_name: input.entity_name ?? null, page_count: 0 },
      outputs: {
        contacts: { emails: [], phones: [] },
        people: [],
      },
      errors: [buildToolError("NO_PAGES", "No pages provided for contact extraction", false)],
    });
  }

  const allEmails = new Set<string>();
  const allPhones = new Set<string>();
  const allPeople: PersonEntry[] = [];
  const evidence: EvidenceItem[] = [];
  const social: SocialLinks = {};
  let contactPageUrl: string | undefined;
  let contactFormUrl: string | undefined;
  const seenPeopleNames = new Set<string>();

  for (const page of pages) {
    const { url, text_clean } = page;
    if (!text_clean) continue;

    const emails = extractEmails(text_clean);
    for (const email of emails) {
      if (!allEmails.has(email)) {
        allEmails.add(email);
        evidence.push({
          source_type: "website",
          source_url: url,
          captured_at: new Date().toISOString(),
          quote: `Email found: ${email}`,
          field_supported: "contacts.emails",
        });
      }
    }

    const phones = extractPhones(text_clean);
    for (const phone of phones) {
      if (!allPhones.has(phone)) {
        allPhones.add(phone);
        evidence.push({
          source_type: "website",
          source_url: url,
          captured_at: new Date().toISOString(),
          quote: `Phone found: ${phone}`,
          field_supported: "contacts.phones",
        });
      }
    }

    const pageSocial = extractSocial(text_clean);
    for (const [key, value] of Object.entries(pageSocial)) {
      if (value && !social[key as keyof SocialLinks]) {
        social[key as keyof SocialLinks] = value;
        evidence.push({
          source_type: "website",
          source_url: url,
          captured_at: new Date().toISOString(),
          quote: `Social link found: ${value}`,
          field_supported: `contacts.social.${key}`,
        });
      }
    }

    if (!contactPageUrl && detectContactPage(url)) {
      contactPageUrl = url;
      evidence.push({
        source_type: "website",
        source_url: url,
        captured_at: new Date().toISOString(),
        quote: `Contact page detected from URL pattern: ${url}`,
        field_supported: "contacts.contact_page_url",
      });
    }
    if (!contactFormUrl && detectContactForm(text_clean)) {
      contactFormUrl = url;
      evidence.push({
        source_type: "website",
        source_url: url,
        captured_at: new Date().toISOString(),
        quote: `Contact form detected on page: ${url}`,
        field_supported: "contacts.contact_form_url",
      });
    }

    const people = extractPeople(text_clean, url);
    for (const person of people) {
      if (!seenPeopleNames.has(person.name.toLowerCase())) {
        seenPeopleNames.add(person.name.toLowerCase());
        allPeople.push(person);
        evidence.push({
          source_type: "website",
          source_url: url,
          captured_at: new Date().toISOString(),
          quote: `Person: ${person.name}, Role: ${person.role}`,
          field_supported: "people",
        });
      }
    }
  }

  const contacts: ContactsOutput = {
    emails: Array.from(allEmails),
    phones: Array.from(allPhones),
  };
  if (contactPageUrl) contacts.contact_page_url = contactPageUrl;
  if (contactFormUrl) contacts.contact_form_url = contactFormUrl;
  if (Object.keys(social).length > 0) contacts.social = social;

  const outputs: ContactExtractOutput = {
    contacts,
    people: allPeople,
  };

  const totalExtracted = allEmails.size + allPhones.size + allPeople.length;

  return buildToolResult({
    tool_name: TOOL_NAME,
    tool_version: TOOL_VERSION,
    run_id: runId,
    goal_id: goalId,
    inputs: {
      entity_name: input.entity_name ?? null,
      page_count: pages.length,
    },
    outputs: outputs as unknown as Record<string, unknown>,
    evidence,
    confidence: totalExtracted > 0 ? Math.min(1, 0.5 + totalExtracted * 0.1) : 0,
  });
}
