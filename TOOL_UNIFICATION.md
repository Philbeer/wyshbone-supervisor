# Tool Execution Unification

## Overview

All tool execution logic now lives in **wyshbone-ui** as a single source of truth.
The Supervisor calls the UI's unified `/api/tools/execute` endpoint instead of duplicating tool implementations.

## Architecture

```
┌─────────────────┐
│  Supervisor     │
│  (Orchestrator) │
└────────┬────────┘
         │
         │ HTTP POST /api/tools/execute
         │
         ▼
┌─────────────────┐
│  Wyshbone UI    │
│  (Tool Engine)  │
└────────┬────────┘
         │
         │ Logs to
         │
         ▼
┌─────────────────┐
│  Control Tower  │
│  (Analytics)    │
└─────────────────┘
```

## Unified Endpoint

**URL:** `http://localhost:5000/api/tools/execute`

**Method:** POST

**Request Body:**
```json
{
  "tool": "search_google_places",
  "params": {
    "query": "craft breweries",
    "location": "Leeds",
    "maxResults": 20
  },
  "userId": "user123",
  "sessionId": "session456"
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "places": [...],
    "count": 15
  },
  "note": "Found 15 businesses"
}
```

## Available Tools

| Tool Name | Description | Required Params |
|-----------|-------------|-----------------|
| `search_google_places` | Search businesses via Google Places | `query`, `location` |
| `deep_research` | Start background research job | `prompt` or `topic` |
| `batch_contact_finder` | Find contacts for businesses | `query`, `location` |
| `create_scheduled_monitor` | Create scheduled monitoring | `label` |
| `get_nudges` | Get AI follow-up suggestions | (none) |
| `draft_email` | Generate email draft | `to_role`, `purpose` |

See `/api/tools/list` for full tool documentation.

## Supervisor Integration

The Supervisor uses `server/actions/ui-tool-client.ts` to call the UI endpoint:

```typescript
import { executeToolViaUI } from './ui-tool-client';

const result = await executeToolViaUI(
  'search_google_places',
  { query: 'pubs', location: 'Manchester' },
  'user123'
);
```

## Configuration

Set the UI endpoint URL via environment variable:

```bash
WYSHBONE_UI_URL=http://localhost:5000
```

Defaults to `http://localhost:5000` if not set.

## Benefits

1. **Zero Duplication** - One implementation, not two
2. **Consistent Logging** - All tool calls logged to Tower
3. **Single Source of Truth** - Bugs fixed in one place
4. **Easy Maintenance** - Add new tools in UI only
5. **Consistent Behavior** - UI and Supervisor get identical results

## Migration from Old System

Old system (deprecated):
- `server/actions/executors.ts` - Duplicate implementations
- Each tool implemented twice (UI + Supervisor)

New system:
- `server/actions/ui-tool-client.ts` - HTTP client
- All tools in wyshbone-ui only
- Supervisor makes HTTP calls to UI

## Testing

Test a tool via curl:

```bash
curl -X POST http://localhost:5000/api/tools/execute \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "search_google_places",
    "params": {
      "query": "breweries",
      "location": "Leeds"
    }
  }'
```

Check Tower logs to verify execution was logged.
