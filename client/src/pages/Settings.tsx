import { Card, CardHeader, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Settings as SettingsIcon, Database, Mail, MapPin, CheckCircle } from "lucide-react";
import { useState } from "react";

export default function Settings() {
  const [enabled, setEnabled] = useState(true);
  const [tickMinutes, setTickMinutes] = useState("1");
  const [maxPlaces, setMaxPlaces] = useState("60");
  const [maxHunter, setMaxHunter] = useState("20");

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="flex-1 overflow-auto">
        <header className="border-b p-6">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure supervisor behavior and integrations
          </p>
        </header>

        <div className="p-6 max-w-4xl space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <SettingsIcon className="h-5 w-5" />
                Supervisor Configuration
              </CardTitle>
              <CardDescription>
                Control how the supervisor polls for signals and generates leads
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Enable Supervisor</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow the supervisor to automatically find leads
                  </p>
                </div>
                <Switch 
                  checked={enabled} 
                  onCheckedChange={setEnabled}
                  data-testid="switch-enabled"
                />
              </div>

              <Separator />

              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="tick">Polling Interval (minutes)</Label>
                  <Input
                    id="tick"
                    type="number"
                    value={tickMinutes}
                    onChange={(e) => setTickMinutes(e.target.value)}
                    data-testid="input-tick-minutes"
                  />
                  <p className="text-xs text-muted-foreground">
                    How often to check for new user signals
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="places">Max Places Lookups Per Tick</Label>
                  <Input
                    id="places"
                    type="number"
                    value={maxPlaces}
                    onChange={(e) => setMaxPlaces(e.target.value)}
                    data-testid="input-max-places"
                  />
                  <p className="text-xs text-muted-foreground">
                    Rate limit for Google Places API calls
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="hunter">Max Email Lookups Per Tick</Label>
                  <Input
                    id="hunter"
                    type="number"
                    value={maxHunter}
                    onChange={(e) => setMaxHunter(e.target.value)}
                    data-testid="input-max-hunter"
                  />
                  <p className="text-xs text-muted-foreground">
                    Rate limit for email finder API calls
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="h-5 w-5" />
                Integrations
              </CardTitle>
              <CardDescription>
                Manage external service connections
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-4 border rounded-md">
                <div className="flex items-center gap-3">
                  <Database className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Supabase</p>
                    <p className="text-sm text-muted-foreground">Database for signals and leads</p>
                  </div>
                </div>
                <Badge variant="default" className="flex items-center gap-1">
                  <CheckCircle className="h-3 w-3" />
                  Connected
                </Badge>
              </div>

              <div className="flex items-center justify-between p-4 border rounded-md">
                <div className="flex items-center gap-3">
                  <MapPin className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Google Places API</p>
                    <p className="text-sm text-muted-foreground">Location-based prospect search</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" data-testid="button-configure-places">
                  Configure
                </Button>
              </div>

              <div className="flex items-center justify-between p-4 border rounded-md">
                <div className="flex items-center gap-3">
                  <Mail className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="font-medium">Email Finder</p>
                    <p className="text-sm text-muted-foreground">Contact discovery service</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" data-testid="button-configure-email">
                  Configure
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="button-cancel">Cancel</Button>
            <Button data-testid="button-save">Save Changes</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
