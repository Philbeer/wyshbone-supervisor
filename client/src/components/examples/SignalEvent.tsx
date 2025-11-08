import { SignalEvent } from "../SignalEvent";

export default function SignalEventExample() {
  const mockSignal = {
    id: "signal-1",
    userId: "user-123",
    type: "profile_update",
    payload: {
      userProfile: {
        userId: "user-123",
        industry: "brewery",
        location: {
          city: "Manchester",
          country: "UK",
          radiusKm: 25
        },
        prefs: {
          packaging: "cans"
        }
      }
    },
    createdAt: new Date()
  };

  return (
    <div className="p-8 max-w-2xl">
      <SignalEvent signal={mockSignal} />
    </div>
  );
}
