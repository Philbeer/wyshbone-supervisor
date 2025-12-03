/**
 * Lead Finder Feature Module
 * 
 * Provides lead search functionality with mock data for now.
 * SUP-6: Lead Finder Feature Pack
 */

/**
 * A mock lead returned by the lead finder
 */
export interface MockLead {
  businessName: string;
  address: string;
  score: number;
}

/**
 * Parameters for running the lead finder
 */
export interface LeadFinderParams {
  query: string;
  location: string;
}

/**
 * Result from the lead finder
 */
export interface LeadFinderResult {
  leads: MockLead[];
  count: number;
}

/**
 * Hardcoded mock leads for development/testing
 */
const MOCK_LEADS: MockLead[] = [
  {
    businessName: "Bristol Dental Practice",
    address: "45 Queen Square, Bristol BS1 4LH",
    score: 92
  },
  {
    businessName: "Manchester Smiles Clinic",
    address: "12 Piccadilly Gardens, Manchester M1 1RG",
    score: 87
  },
  {
    businessName: "London Dental Hub",
    address: "78 Harley Street, London W1G 7HJ",
    score: 95
  },
  {
    businessName: "Birmingham Family Dentistry",
    address: "23 Colmore Row, Birmingham B3 2BJ",
    score: 78
  },
  {
    businessName: "Leeds Dental Centre",
    address: "56 The Headrow, Leeds LS1 8EQ",
    score: 84
  }
];

/**
 * Run the lead finder with given parameters.
 * 
 * Currently returns mock data. In the future, this will
 * integrate with real data sources.
 * 
 * @param params - Search parameters (query and location)
 * @returns Promise resolving to leads and count
 */
export async function runLeadFinder(params: LeadFinderParams): Promise<LeadFinderResult> {
  console.log(`[LeadFinder] Starting lead search...`);
  console.log(`[LeadFinder] Query: "${params.query}", Location: "${params.location}"`);
  
  // Simulate async operation (pretend to fetch leads)
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Filter leads based on location if provided (simple mock filtering)
  const filteredLeads = params.location 
    ? MOCK_LEADS.filter(lead => 
        lead.address.toLowerCase().includes(params.location.toLowerCase())
      )
    : MOCK_LEADS;
  
  // If no leads match the location filter, return all leads (for demo purposes)
  const leads = filteredLeads.length > 0 ? filteredLeads : MOCK_LEADS;
  
  console.log(`[LeadFinder] Found ${leads.length} leads`);
  
  return {
    leads,
    count: leads.length
  };
}

