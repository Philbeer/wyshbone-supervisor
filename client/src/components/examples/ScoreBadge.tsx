import { ScoreBadge } from "../ScoreBadge";

export default function ScoreBadgeExample() {
  return (
    <div className="flex gap-4 items-center p-8">
      <ScoreBadge score={0.85} />
      <ScoreBadge score={0.65} />
      <ScoreBadge score={0.35} />
      <ScoreBadge score={0.92} size="sm" />
    </div>
  );
}
