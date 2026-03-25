export interface ResponseBuilderInput {
  businessType: string;
  location: string;
  requestedCount: number | null;
  deliveredCount: number;
  verifiedCount: number;
  towerVerdict: string | null;
  runFailed: boolean;
  failureReason: string;
  circuitBreakerFired: boolean;
  loopsUsed: number;
  executorsUsed: string[];
  monitorCreated: boolean;
  deliveryNote: string | null;
}

export function buildNaturalResponse(input: ResponseBuilderInput): string {
  const {
    businessType, location, requestedCount, deliveredCount, verifiedCount,
    towerVerdict, runFailed, failureReason, circuitBreakerFired,
    loopsUsed, executorsUsed, monitorCreated, deliveryNote,
  } = input;

  if (runFailed) {
    return `I wasn't able to complete this search. ${failureReason ? failureReason.substring(0, 150) : 'An unexpected error occurred.'} You can try rephrasing your query or running it again.`;
  }

  const parts: string[] = [];

  // Main result line
  if (deliveredCount === 0) {
    parts.push(`I searched for ${businessType} in ${location} but couldn't find any verified results.`);
    if (loopsUsed > 1) {
      parts.push(`I tried ${executorsUsed.join(' and ')} across ${loopsUsed} search rounds.`);
    }
    parts.push(`Try broadening your search criteria or checking a wider area.`);
    return parts.join(' ');
  }

  // Successful results
  if (requestedCount && deliveredCount >= requestedCount) {
    parts.push(`I found ${deliveredCount} ${businessType} in ${location} — all ${requestedCount} you asked for.`);
  } else if (requestedCount && deliveredCount < requestedCount) {
    parts.push(`I found ${deliveredCount} ${businessType} in ${location} out of the ${requestedCount} you asked for.`);
  } else {
    parts.push(`I found ${deliveredCount} ${businessType} in ${location}.`);
  }

  // Verification summary
  if (verifiedCount > 0 && verifiedCount < deliveredCount) {
    parts.push(`${verifiedCount} have verified evidence from their websites.`);
  } else if (verifiedCount === deliveredCount && deliveredCount > 0) {
    parts.push(`All have verified evidence.`);
  }

  // Shortfall explanation
  if (deliveryNote) {
    parts.push(deliveryNote);
  }

  // Monitor note
  if (monitorCreated) {
    parts.push(`I've set up ongoing monitoring and will let you know when new results appear.`);
  }

  // Suggested next steps (only if no monitor was created)
  if (!monitorCreated && deliveredCount > 0) {
    const suggestions: string[] = [];
    if (deliveredCount >= 3) {
      suggestions.push(`"email the top one"`);
    }
    suggestions.push(`"keep monitoring for new ones"`);
    if (requestedCount && deliveredCount < requestedCount) {
      suggestions.push(`"try a wider area"`);
    }
    if (suggestions.length > 0) {
      parts.push(`You can say ${suggestions.join(', ')} or ask me to refine the results.`);
    }
  }

  return parts.join(' ');
}
