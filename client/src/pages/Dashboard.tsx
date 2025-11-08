import { StatsCard } from "@/components/StatsCard";
import { SuggestionsPanel } from "@/components/SuggestionsPanel";
import { EmptyState } from "@/components/EmptyState";
import { TrendingUp, Activity, Mail, CheckCircle, Inbox } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function Dashboard() {
  const mockStats = {
    leadsGenerated: 47,
    activeSignals: 3,
    emailMatches: 31,
    status: "Online"
  };

  const mockLeads = [
    {
      id: "1",
      userId: "user-1",
      rationale: "Based on brewery profile - bottle shops near Manchester",
      source: "google_places_new",
      score: 0.85,
      lead: {
        name: "The Craft Beer Shop",
        address: "123 Main St, Manchester, UK",
        place_id: "place1",
        domain: "craftbeershop.co.uk",
        emailCandidates: ["info@craftbeershop.co.uk"],
        tags: ["bottle_shop"]
      },
      createdAt: new Date()
    },
    {
      id: "2",
      userId: "user-1",
      rationale: "Freehouse pub matching profile preferences",
      source: "google_places_new",
      score: 0.72,
      lead: {
        name: "The Old Oak Inn",
        address: "45 High Street, Leeds, UK",
        place_id: "place2",
        domain: "oldoakinn.co.uk",
        emailCandidates: [],
        tags: ["freehouse", "pub"]
      },
      createdAt: new Date()
    },
    {
      id: "3",
      userId: "user-1",
      rationale: "Premium bottle shop with craft beer focus",
      source: "google_places_new",
      score: 0.91,
      lead: {
        name: "Hop & Grain Bottle Shop",
        address: "78 Market Street, Sheffield, UK",
        place_id: "place3",
        domain: "hopandgrain.co.uk",
        emailCandidates: ["hello@hopandgrain.co.uk", "sales@hopandgrain.co.uk"],
        tags: ["bottle_shop", "craft_beer"]
      },
      createdAt: new Date()
    }
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b p-6">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Proactive lead generation powered by AI
          </p>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatsCard
                title="Leads Generated"
                value={mockStats.leadsGenerated}
                icon={TrendingUp}
                description="Today"
                trend={{ value: "+12%", positive: true }}
              />
              <StatsCard
                title="Active Signals"
                value={mockStats.activeSignals}
                icon={Activity}
                description="Last 5 minutes"
              />
              <StatsCard
                title="Email Matches"
                value={mockStats.emailMatches}
                icon={Mail}
                description="With contact info"
              />
              <StatsCard
                title="Integration Status"
                value={mockStats.status}
                icon={CheckCircle}
                description="All systems operational"
              />
            </div>

            <Tabs defaultValue="all" className="w-full">
              <TabsList data-testid="tabs-leads">
                <TabsTrigger value="all" data-testid="tab-all">All Leads</TabsTrigger>
                <TabsTrigger value="high" data-testid="tab-high-priority">High Priority</TabsTrigger>
                <TabsTrigger value="review" data-testid="tab-needs-review">Needs Review</TabsTrigger>
              </TabsList>
              <TabsContent value="all" className="mt-4">
                <ScrollArea className="h-[400px]">
                  <div className="space-y-4 pr-4">
                    <EmptyState
                      icon={Inbox}
                      title="No leads in your list yet"
                      description="Add leads from the suggestions panel on the right to review and manage them here."
                    />
                  </div>
                </ScrollArea>
              </TabsContent>
              <TabsContent value="high" className="mt-4">
                <ScrollArea className="h-[400px]">
                  <EmptyState
                    icon={TrendingUp}
                    title="No high priority leads"
                    description="Leads with scores above 70 will appear here."
                  />
                </ScrollArea>
              </TabsContent>
              <TabsContent value="review" className="mt-4">
                <ScrollArea className="h-[400px]">
                  <EmptyState
                    icon={Activity}
                    title="All caught up"
                    description="No leads need review at this time."
                  />
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>

      <div className="w-96 flex-shrink-0">
        <SuggestionsPanel
          leads={mockLeads}
          onAddToList={(id) => console.log('Add to list:', id)}
          onDraftEmail={(id) => console.log('Draft email:', id)}
          onRefresh={() => console.log('Refresh suggestions')}
        />
      </div>
    </div>
  );
}
