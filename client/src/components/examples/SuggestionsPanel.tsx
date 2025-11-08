import { SuggestionsPanel } from "../SuggestionsPanel";

export default function SuggestionsPanelExample() {
  const mockLeads = [
    {
      id: "1",
      userId: "user-1",
      rationale: "Based on brewery near Manchester",
      source: "google_places_new",
      score: 0.85,
      lead: {
        name: "The Craft Beer Shop",
        address: "123 Main St, Manchester",
        domain: "craftbeershop.co.uk",
        emailCandidates: ["info@craftbeershop.co.uk"],
        tags: []
      },
      createdAt: new Date()
    },
    {
      id: "2",
      userId: "user-1",
      rationale: "Freehouse pub matching profile",
      source: "google_places_new",
      score: 0.72,
      lead: {
        name: "The Old Oak Inn",
        address: "45 High Street, Leeds",
        domain: "oldoakinn.co.uk",
        emailCandidates: [],
        tags: ["freehouse"]
      },
      createdAt: new Date()
    }
  ];

  return (
    <div className="h-screen w-96">
      <SuggestionsPanel 
        leads={mockLeads}
        onAddToList={(id) => console.log('Add:', id)}
        onDraftEmail={(id) => console.log('Email:', id)}
        onRefresh={() => console.log('Refresh')}
      />
    </div>
  );
}
