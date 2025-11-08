import { useQuery } from "@tanstack/react-query";
import type { SuggestedLead } from "@shared/schema";
import { LeadCard } from "@/components/LeadCard";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";

export default function Leads() {
  const { data: leads = [], isLoading, refetch } = useQuery<SuggestedLead[]>({
    queryKey: ["/api/leads"],
  });

  const handleRefresh = () => {
    refetch();
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="border-b p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
            <p className="text-sm text-muted-foreground mt-1">
              AI-generated prospects based on your signals
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            data-testid="button-refresh-leads"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="p-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <p className="text-muted-foreground">Loading leads...</p>
            </div>
          ) : leads.length === 0 ? (
            <EmptyState
              title="No leads yet"
              description="The supervisor will automatically generate leads based on your signals"
              icon="inbox"
            />
          ) : (
            <div className="space-y-4" data-testid="leads-list">
              {leads.map((lead) => (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  onAddToList={() => console.log('Add to list:', lead.id)}
                  onDraftEmail={() => console.log('Draft email:', lead.id)}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
