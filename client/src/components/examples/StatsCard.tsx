import { StatsCard } from "../StatsCard";
import { TrendingUp, Activity, Mail, CheckCircle } from "lucide-react";

export default function StatsCardExample() {
  return (
    <div className="grid grid-cols-2 gap-4 p-8 max-w-4xl">
      <StatsCard 
        title="Leads Generated" 
        value="47" 
        icon={TrendingUp}
        description="Today"
        trend={{ value: "+12%", positive: true }}
      />
      <StatsCard 
        title="Active Signals" 
        value="3" 
        icon={Activity}
        description="Last 5 minutes"
      />
      <StatsCard 
        title="Email Matches" 
        value="31" 
        icon={Mail}
        description="With contact info"
      />
      <StatsCard 
        title="Integration Status" 
        value="Online" 
        icon={CheckCircle}
        description="All systems operational"
      />
    </div>
  );
}
