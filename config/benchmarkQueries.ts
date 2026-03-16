export const BENCHMARK_QUERIES = [
  "Find dentists in Brighton",
  "Find coffee roasters in Manchester",
  "Find pubs in Arundel mentioning live music",
  "Find cafes in Bristol that mention vegan food",
  "Find pubs called Swan in Sussex",
  "Find organisations that work with Blackpool council",
  "Find companies partnered with the University of Manchester",
  "Find pubs in York that mention quiz night",
  "Find hotels in London mentioning rooftop bars",
  "Find the best rated coffee shops in Cambridge",
  "Find breweries supplying pubs in Leeds",
  "Find pubs in Brighton that brew their own beer"
];

const _benchmarkQueriesLower = BENCHMARK_QUERIES.map(q => q.toLowerCase().trim());

export function getBenchmarkQueryId(query: string): string | null {
  const idx = _benchmarkQueriesLower.indexOf(query.toLowerCase().trim());
  if (idx === -1) return null;
  return `B${String(idx + 1).padStart(2, '0')}`;
}
