import { LeadCard } from "./LeadCard";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, RefreshCw } from "lucide-react";
import type { SuggestedLead } from "@shared/schema";

interface SuggestionsPanelProps {
  leads: SuggestedLead[];
  onAddToList?: (leadId: string) => void;
  onDraftEmail?: (leadId: string) => void;
  onRefresh?: () => void;
  loading?: boolean;
}

export function SuggestionsPanel({ 
  leads, 
  onAddToList, 
  onDraftEmail,
  onRefresh,
  loading = false 
}: SuggestionsPanelProps) {
  return (
    <div className="flex flex-col h-full border-l bg-card">
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="font-semibold">Live Suggestions</h2>
          </div>
          <Button 
            size="icon" 
            variant="ghost"
            onClick={onRefresh}
            disabled={loading}
            data-testid="button-refresh-suggestions"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {leads.length} new prospects found
        </p>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3">
          {leads.length === 0 ? (
            <div className="text-center py-12">
              <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No suggestions yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                The supervisor will find leads automatically
              </p>
            </div>
          ) : (
            leads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onAddToList={onAddToList}
                onDraftEmail={onDraftEmail}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
