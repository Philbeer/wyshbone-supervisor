import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/EmptyState";
import { Play, Radio, CheckCircle, AlertTriangle, Clock, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface ActivityEvent {
  id: string;
  eventType: string;
  actionTaken: string;
  status: string;
  summary: string;
  runId: string;
  timestamp: number;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
}

function eventIcon(eventType: string, status: string) {
  if (status === "failed") return <AlertTriangle className="h-4 w-4 text-destructive" />;
  if (eventType === "plan_started") return <Play className="h-4 w-4 text-primary" />;
  if (eventType === "plan_completed") return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />;
  if (eventType === "step_started") return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (eventType === "step_completed") return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}

function statusBadge(status: string) {
  if (status === "success") return <Badge variant="secondary">success</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="outline">pending</Badge>;
}

export default function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const connectStream = useCallback((filterRunId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = `/api/afr/stream?run_id=${encodeURIComponent(filterRunId)}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("connected", () => {
      setConnected(true);
    });

    const handleEvent = (e: MessageEvent) => {
      try {
        const parsed: ActivityEvent = JSON.parse(e.data);
        if (parsed.runId !== filterRunId) return;
        setEvents(prev => [...prev, parsed]);
      } catch {}
    };

    const eventTypes = [
      "plan_started",
      "plan_completed",
      "plan_failed",
      "step_started",
      "step_completed",
      "step_failed",
      "activity",
      "tools_update",
      "tower_evaluation",
      "tower_decision",
    ];
    eventTypes.forEach(t => es.addEventListener(t, handleEvent));

    es.onerror = () => {
      setConnected(false);
    };
  }, []);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const handleRunDemo = async () => {
    setDemoRunning(true);
    setEvents([]);
    try {
      const res = await apiRequest("POST", "/api/debug/demo-plan-run");
      const data = await res.json();
      if (data.ok && data.runId) {
        setRunId(data.runId);
        connectStream(data.runId);
      }
    } catch (err: any) {
      console.error("Demo run failed:", err);
    } finally {
      setDemoRunning(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b p-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Live Activity</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Real-time Supervisor execution events
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-destructive"}`} />
                <span className="text-xs text-muted-foreground">
                  {connected ? "Streaming" : "Disconnected"}
                </span>
              </div>
              <Button
                onClick={handleRunDemo}
                disabled={demoRunning}
                data-testid="button-run-supervisor-demo"
              >
                {demoRunning ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Run Supervisor Demo
              </Button>
            </div>
          </div>
          {runId && (
            <p className="text-xs text-muted-foreground mt-2 font-mono" data-testid="text-run-id">
              Run: {runId}
            </p>
          )}
        </header>

        <div className="flex-1 overflow-hidden p-6">
          {events.length > 0 ? (
            <Card className="h-full flex flex-col">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Radio className="h-4 w-4" />
                  Events ({events.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden p-0">
                <ScrollArea className="h-full px-6 pb-4" ref={scrollRef}>
                  <div className="space-y-2 pr-4">
                    {events.map((ev, idx) => (
                      <div
                        key={ev.id || idx}
                        className="flex items-start gap-3 p-3 border rounded-md"
                        data-testid={`event-row-${idx}`}
                      >
                        <div className="mt-0.5">{eventIcon(ev.eventType, ev.status)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium" data-testid={`text-event-summary-${idx}`}>
                              {ev.summary}
                            </span>
                            {statusBadge(ev.status)}
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 font-mono" data-testid={`text-event-action-${idx}`}>
                            {ev.actionTaken}
                          </p>
                          {ev.errorMessage && (
                            <p className="text-xs text-destructive mt-1" data-testid={`text-event-error-${idx}`}>
                              {ev.errorMessage}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(ev.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          ) : (
            <EmptyState
              icon={Radio}
              title="No activity events"
              description="Click 'Run Supervisor Demo' to execute a demo pipeline and watch events stream in real-time."
            />
          )}
        </div>
      </div>
    </div>
  );
}
