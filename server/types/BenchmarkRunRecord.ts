import { FailureClassification } from '../evaluator/failureClassification';

export interface BenchmarkRunRecord {
  run_id: string;
  query: string;
  requested_count: number;
  delivered_count: number;
  verified_count: number;
  tower_verdict: string;
  replans_triggered: number;
  failure_classification: FailureClassification;
  notes?: string;
  timestamp: string;
}
