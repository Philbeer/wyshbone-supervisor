import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, Target, Star, Activity, MessageSquare } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface UserContext {
  userId: string;
  profile?: {
    companyName?: string;
    companyDomain?: string;
    inferredIndustry?: string;
    primaryObjective?: string;
    secondaryObjectives?: string[];
    targetMarkets?: string[];
    productsOrServices?: string[];
    confidence?: number;
  };
  facts: Array<{
    fact: string;
    score: number;
    category: string;
    createdAt: string;
  }>;
  recentMessages: Array<{
    role: string;
    content: string;
    createdAt: string;
  }>;
  monitors: Array<{
    label: string;
    description: string;
    monitorType: string;
  }>;
  researchRuns: Array<{
    label: string;
    prompt: string;
  }>;
}

interface UserContextPanelProps {
  context?: UserContext;
  isLoading?: boolean;
}

export function UserContextPanel({ context, isLoading }: UserContextPanelProps) {
  if (isLoading) {
    return (
      <Card data-testid="card-user-context">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            User Context
          </CardTitle>
          <CardDescription>Loading user profile...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!context || (!context.profile && context.facts.length === 0 && context.recentMessages.length === 0 && context.monitors.length === 0)) {
    return (
      <Card data-testid="card-user-context">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            User Context
          </CardTitle>
          <CardDescription>No user data available yet</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          User context will appear here once the Wyshbone UI app sends profile data, facts, and chat history.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="panel-user-context">
      {context.profile && (
        <Card data-testid="card-user-profile">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Company Profile
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {context.profile.companyName && (
              <div data-testid="text-company-name">
                <div className="text-xs text-muted-foreground">Company</div>
                <div className="font-medium">{context.profile.companyName}</div>
              </div>
            )}
            {context.profile.inferredIndustry && (
              <div data-testid="text-industry">
                <div className="text-xs text-muted-foreground">Industry</div>
                <Badge variant="secondary">{context.profile.inferredIndustry}</Badge>
              </div>
            )}
            {context.profile.confidence !== undefined && (
              <div data-testid="text-confidence">
                <div className="text-xs text-muted-foreground">AI Confidence</div>
                <div className="text-sm">{context.profile.confidence}%</div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {context.profile?.primaryObjective && (
        <Card data-testid="card-objectives">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Target className="h-5 w-5" />
              Objectives
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div data-testid="text-primary-objective">
              <div className="text-xs text-muted-foreground">Primary</div>
              <div className="text-sm">{context.profile.primaryObjective}</div>
            </div>
            {context.profile.secondaryObjectives && context.profile.secondaryObjectives.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground mb-1">Secondary</div>
                <div className="flex flex-wrap gap-1">
                  {context.profile.secondaryObjectives.map((obj, idx) => (
                    <Badge key={idx} variant="outline" data-testid={`badge-secondary-objective-${idx}`}>
                      {obj}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {context.facts.length > 0 && (
        <Card data-testid="card-facts">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-5 w-5" />
              Top Insights
            </CardTitle>
            <CardDescription>{context.facts.length} high-value facts</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[200px]">
              <div className="space-y-2 pr-4">
                {context.facts.map((fact, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-md border text-sm"
                    data-testid={`fact-${idx}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex-1">{fact.fact}</span>
                      <Badge variant="secondary" className="text-xs">
                        {fact.score}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {fact.category}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {context.monitors.length > 0 && (
        <Card data-testid="card-monitors">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Active Monitoring
            </CardTitle>
            <CardDescription>{context.monitors.length} active monitors</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {context.monitors.slice(0, 3).map((monitor, idx) => (
                <div
                  key={idx}
                  className="text-sm"
                  data-testid={`monitor-${idx}`}
                >
                  <div className="font-medium">{monitor.label}</div>
                  <div className="text-xs text-muted-foreground">{monitor.description}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {context.recentMessages.length > 0 && (
        <Card data-testid="card-messages">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Recent Conversation
            </CardTitle>
            <CardDescription>{context.recentMessages.length} messages</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[300px]">
              <div className="space-y-3 pr-4">
                {context.recentMessages.map((message, idx) => (
                  <div
                    key={idx}
                    role="article"
                    className={`p-3 rounded-md text-sm ${
                      message.role === 'user' 
                        ? 'bg-primary/10 border border-primary/20' 
                        : 'bg-muted'
                    }`}
                    data-testid={`message-${idx}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant={message.role === 'user' ? 'default' : 'secondary'} className="text-xs">
                        {message.role}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(message.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-sm">{message.content}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
