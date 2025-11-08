import { SignalEvent } from "@/components/SignalEvent";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Activity, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { UserSignal } from "@shared/schema";

export default function Signals() {
  const { data: signals = [], isLoading, refetch } = useQuery<UserSignal[]>({
    queryKey: ["/api/signals"],
  });

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Signals Monitor</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Real-time user signal events
              </p>
            </div>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
              data-testid="button-refresh-signals"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="p-6">
            {signals.length > 0 ? (
              <ScrollArea className="h-[calc(100vh-200px)]">
                <div className="space-y-3 pr-4">
                  {signals.map((signal) => (
                    <SignalEvent key={signal.id} signal={signal} />
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <EmptyState
                icon={Activity}
                title="No signals detected"
                description="User signals will appear here as they are generated. The supervisor monitors these to find relevant leads."
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
