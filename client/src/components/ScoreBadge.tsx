import { Badge } from "@/components/ui/badge";

interface ScoreBadgeProps {
  score: number;
  size?: "sm" | "default";
}

export function ScoreBadge({ score, size = "default" }: ScoreBadgeProps) {
  const percentage = Math.round(score * 100);
  
  const variant = percentage >= 70 ? "default" : percentage >= 50 ? "secondary" : "outline";
  
  return (
    <Badge 
      variant={variant} 
      className={size === "sm" ? "text-xs px-2 py-0.5" : ""}
      data-testid="badge-score"
    >
      {percentage}
    </Badge>
  );
}
