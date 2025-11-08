import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScoreBadge } from "./ScoreBadge";
import { Mail, ExternalLink, MapPin, Plus } from "lucide-react";
import type { SuggestedLead } from "@shared/schema";

interface LeadCardProps {
  lead: SuggestedLead;
  onAddToList?: (leadId: string) => void;
  onDraftEmail?: (leadId: string) => void;
}

export function LeadCard({ lead, onAddToList, onDraftEmail }: LeadCardProps) {
  const leadData = lead.lead as any;
  
  return (
    <Card className="p-4 hover-elevate" data-testid={`card-lead-${lead.id}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-base truncate" data-testid="text-lead-name">
            {leadData.name}
          </h3>
          {leadData.address && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <MapPin className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">{leadData.address}</span>
            </p>
          )}
        </div>
        <ScoreBadge score={lead.score} size="sm" />
      </div>
      
      <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
        {lead.rationale}
      </p>
      
      {leadData.emailCandidates && leadData.emailCandidates.length > 0 && (
        <div className="mb-3">
          <p className="text-xs font-medium mb-1">Email found:</p>
          <p className="text-xs text-muted-foreground truncate">{leadData.emailCandidates[0]}</p>
        </div>
      )}
      
      <div className="flex gap-2">
        <Button 
          size="sm" 
          variant="default" 
          className="flex-1"
          onClick={() => onAddToList?.(lead.id)}
          data-testid="button-add-lead"
        >
          <Plus className="h-3 w-3 mr-1" />
          Add
        </Button>
        {leadData.emailCandidates && leadData.emailCandidates.length > 0 && (
          <Button 
            size="sm" 
            variant="outline"
            onClick={() => onDraftEmail?.(lead.id)}
            data-testid="button-email-lead"
          >
            <Mail className="h-3 w-3" />
          </Button>
        )}
        {leadData.domain && (
          <Button 
            size="sm" 
            variant="ghost"
            onClick={() => window.open(`https://${leadData.domain}`, '_blank')}
            data-testid="button-visit-website"
          >
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
      </div>
    </Card>
  );
}
