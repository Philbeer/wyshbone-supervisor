import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Play, Radio, CheckCircle, AlertTriangle, Clock, Loader2, Inbox, Eye, MapPin, Globe, Phone, Mail } from "lucide-react";
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

interface LeadResult {
  id?: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  place_id: string;
  score?: number;
  emailCandidates?: string[];
}

interface ArtefactData {
  id: string;
  runId: string;
  type: string;
  title: string;
  summary: string | null;
  payloadJson: {
    leads?: LeadResult[];
    query?: string;
    location?: string;
    [key: string]: unknown;
  } | null;
  createdAt: string;
}

function eventIcon(eventType: string, status: string) {
  if (status === "failed") return <AlertTriangle className="h-4 w-4 text-destructive" />;
  if (eventType === "plan_started") return <Play className="h-4 w-4 text-primary" />;
  if (eventType === "plan_completed") return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />;
  if (eventType === "step_started") return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (eventType === "step_completed") return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />;
  if (eventType === "tool_call_started") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (eventType === "tool_call_completed") return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />;
  if (eventType === "mission_received") return <Inbox className="h-4 w-4 text-primary" />;
  if (eventType === "run_completed") return <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />;
  if (eventType === "router_decision") return <Radio className="h-4 w-4 text-primary" />;
  if (eventType === "artefact_created") return <CheckCircle className="h-4 w-4 text-primary" />;
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
  const [resultsOpen, setResultsOpen] = useState(false);
  const [artefacts, setArtefacts] = useState<ArtefactData[]>([]);
  const [artefactsLoading, setArtefactsLoading] = useState(false);
  const [artefactsError, setArtefactsError] = useState<string | null>(null);
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
      "mission_received",
      "run_completed",
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
      "tool_call_started",
      "tool_call_completed",
      "tool_call_failed",
      "router_decision",
      "artefact_created",
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

  const handleViewResults = async (viewRunId: string) => {
    setArtefactsLoading(true);
    setArtefactsError(null);
    setResultsOpen(true);
    setArtefacts([]);
    try {
      const res = await fetch(`/api/afr/artefacts?run_id=${encodeURIComponent(viewRunId)}`);
      if (!res.ok) {
        setArtefactsError(`Failed to load results (${res.status})`);
        return;
      }
      const data: ArtefactData[] = await res.json();
      setArtefacts(data);
    } catch (err) {
      console.error("Failed to fetch artefacts:", err);
      setArtefactsError("Could not connect to the server.");
    } finally {
      setArtefactsLoading(false);
    }
  };

  const hasArtefactId = (metadata: Record<string, unknown>): boolean =>
    typeof metadata?.artefactId === "string";

  const leadsArtefact = artefacts.find(a => a.type === "leads");
  const leads = leadsArtefact?.payloadJson?.leads || [];

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
            <div className="flex items-center gap-3 mt-2">
              <p className="text-xs text-muted-foreground font-mono" data-testid="text-run-id">
                Run: {runId}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleViewResults(runId)}
                data-testid="button-view-results"
              >
                <Eye className="h-3 w-3 mr-1" />
                View results
              </Button>
            </div>
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
                            {ev.eventType === "artefact_created" && hasArtefactId(ev.metadata) && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="ml-auto"
                                onClick={() => handleViewResults(ev.runId)}
                                data-testid={`button-view-artefact-${idx}`}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                View results
                              </Button>
                            )}
                            {ev.eventType === "run_completed" && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="ml-auto"
                                onClick={() => handleViewResults(ev.runId)}
                                data-testid={`button-view-run-results-${idx}`}
                              >
                                <Eye className="h-3 w-3 mr-1" />
                                View results
                              </Button>
                            )}
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

      <Dialog open={resultsOpen} onOpenChange={setResultsOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Run Results
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-auto">
            {artefactsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Loading results...</span>
              </div>
            ) : artefactsError ? (
              <div className="text-center py-8">
                <AlertTriangle className="h-6 w-6 text-destructive mx-auto mb-2" />
                <p className="text-sm text-destructive" data-testid="text-artefacts-error">{artefactsError}</p>
              </div>
            ) : artefacts.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground" data-testid="text-no-results">No results yet</p>
                <p className="text-xs text-muted-foreground mt-1">Artefacts will appear here once the run creates them.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {leadsArtefact && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <div>
                        <h3 className="text-sm font-medium" data-testid="text-artefact-title">{leadsArtefact.title}</h3>
                        {leadsArtefact.summary && (
                          <p className="text-xs text-muted-foreground mt-0.5">{leadsArtefact.summary}</p>
                        )}
                      </div>
                      <Badge variant="secondary" data-testid="badge-leads-count">{leads.length} lead{leads.length !== 1 ? "s" : ""}</Badge>
                    </div>

                    {leadsArtefact.payloadJson?.query && (
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>Query: <span className="font-medium text-foreground">{leadsArtefact.payloadJson.query as string}</span></span>
                        {leadsArtefact.payloadJson?.location && (
                          <span>Location: <span className="font-medium text-foreground">{leadsArtefact.payloadJson.location as string}</span></span>
                        )}
                      </div>
                    )}

                    {leads.length > 0 ? (
                      <div className="space-y-2">
                        {leads.map((lead, idx) => (
                          <Card key={lead.place_id || idx}>
                            <CardContent className="p-4">
                              <div className="flex items-start justify-between gap-2 flex-wrap">
                                <h4 className="text-sm font-medium" data-testid={`text-lead-name-${idx}`}>{lead.name}</h4>
                                {lead.score !== undefined && lead.score !== null && (
                                  <Badge variant="outline" data-testid={`badge-lead-score-${idx}`}>
                                    {(lead.score * 100).toFixed(0)}% match
                                  </Badge>
                                )}
                              </div>
                              <div className="mt-2 space-y-1">
                                {lead.address && (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <MapPin className="h-3 w-3 shrink-0" />
                                    <span data-testid={`text-lead-address-${idx}`}>{lead.address}</span>
                                  </div>
                                )}
                                {lead.phone && (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Phone className="h-3 w-3 shrink-0" />
                                    <span data-testid={`text-lead-phone-${idx}`}>{lead.phone}</span>
                                  </div>
                                )}
                                {lead.website && (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Globe className="h-3 w-3 shrink-0" />
                                    <a
                                      href={lead.website.startsWith("http") ? lead.website : `https://${lead.website}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="underline hover-elevate"
                                      data-testid={`link-lead-website-${idx}`}
                                    >
                                      {lead.website}
                                    </a>
                                  </div>
                                )}
                                {lead.emailCandidates && lead.emailCandidates.length > 0 && (
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Mail className="h-3 w-3 shrink-0" />
                                    <span data-testid={`text-lead-emails-${idx}`}>{lead.emailCandidates.join(", ")}</span>
                                  </div>
                                )}
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground py-2">No leads found for this search.</p>
                    )}
                  </div>
                )}

                {artefacts.filter(a => a.type !== "leads").map((art, idx) => (
                  <Card key={art.id}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <h4 className="text-sm font-medium" data-testid={`text-artefact-other-${idx}`}>{art.title}</h4>
                        <Badge variant="outline">{art.type}</Badge>
                      </div>
                      {art.summary && (
                        <p className="text-xs text-muted-foreground mt-1">{art.summary}</p>
                      )}
                    </CardContent>
                  </Card>
                ))}

                {artefacts[0]?.createdAt && (
                  <p className="text-xs text-muted-foreground">
                    Created {new Date(artefacts[0].createdAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
