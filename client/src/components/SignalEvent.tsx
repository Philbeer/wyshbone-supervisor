import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Clock } from "lucide-react";
import type { UserSignal } from "@shared/schema";

interface SignalEventProps {
  signal: UserSignal;
}

export function SignalEvent({ signal }: SignalEventProps) {
  const payload = signal.payload as any;
  const timestamp = new Date(signal.createdAt!).toLocaleString();
  
  return (
    <Card className="p-4" data-testid={`card-signal-${signal.id}`}>
      <div className="flex items-start gap-3">
        <div className="mt-1">
          <Activity className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="text-xs">
              {signal.type}
            </Badge>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {timestamp}
            </span>
          </div>
          <p className="text-sm font-medium mb-1">User ID: {signal.userId}</p>
          {payload?.userProfile && (
            <div className="text-xs text-muted-foreground space-y-0.5">
              {payload.userProfile.industry && (
                <p>Industry: {payload.userProfile.industry}</p>
              )}
              {payload.userProfile.location && (
                <p>Location: {payload.userProfile.location.city || payload.userProfile.location.country}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
