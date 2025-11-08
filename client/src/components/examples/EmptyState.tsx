import { EmptyState } from "../EmptyState";
import { Inbox } from "lucide-react";

export default function EmptyStateExample() {
  return (
    <div className="p-8">
      <EmptyState 
        icon={Inbox}
        title="No leads yet"
        description="The supervisor will automatically find and suggest leads based on user signals. Check back soon!"
        action={{
          label: "Refresh",
          onClick: () => console.log('Refresh clicked')
        }}
      />
    </div>
  );
}
