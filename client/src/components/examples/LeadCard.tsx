import { LeadCard } from "../LeadCard";

export default function LeadCardExample() {
  const mockLead = {
    id: "1",
    userId: "user-1",
    rationale: "Based on brewery near Manchester - high match for bottle shops",
    source: "google_places_new",
    score: 0.85,
    lead: {
      name: "The Craft Beer Shop",
      address: "123 Main St, Manchester, UK",
      place_id: "ChIJdd4hrwug2EcRmSrV3Vo6llI",
      domain: "craftbeershop.co.uk",
      emailCandidates: ["info@craftbeershop.co.uk"],
      tags: ["bottle_shop", "craft_beer"]
    },
    createdAt: new Date()
  };

  return (
    <div className="p-8 max-w-sm">
      <LeadCard 
        lead={mockLead}
        onAddToList={(id) => console.log('Add to list:', id)}
        onDraftEmail={(id) => console.log('Draft email:', id)}
      />
    </div>
  );
}
