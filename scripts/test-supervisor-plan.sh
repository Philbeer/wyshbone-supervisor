#!/bin/bash
# Test script for Supervisor plan execution endpoint
# Usage: ./scripts/test-supervisor-plan.sh

echo "=============================================="
echo "Testing POST /api/supervisor/execute-plan"
echo "=============================================="

curl -s -X POST http://localhost:5000/api/supervisor/execute-plan \
  -H "Content-Type: application/json" \
  -d '{
    "planId": "test_plan_'$(date +%s)'",
    "userId": "test_user",
    "goal": "Find pubs in Kent GB",
    "steps": [
      {
        "id": "step_1",
        "type": "search",
        "label": "Search for pubs",
        "description": "Find pubs in Kent, GB"
      }
    ],
    "toolMetadata": {
      "toolName": "SEARCH_PLACES",
      "toolArgs": {
        "query": "pubs",
        "location": "Kent",
        "country": "GB"
      }
    }
  }'

echo ""
echo ""
echo "=============================================="
echo "Expected AFR log sequence in agent_activities:"
echo "=============================================="
echo "1. plan_execution_started - pending"
echo "2. step_started:step_1 - pending"
echo "3. step_completed:step_1 - success (if GOOGLE_MAPS_API_KEY set)"
echo "   OR step_failed:step_1 - failed (if API key missing)"
echo "4. plan_execution_completed - success"
echo "   OR plan_execution_failed - failed"
echo ""
echo "Check server logs for [AFR_LOGGER] entries"
