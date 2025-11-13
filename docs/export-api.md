# Export API Documentation

## Overview

The Export API provides safe, read-only access to source code files for external analysis tools, status monitors, and AI assistants (Grok, ChatGPT, etc.).

## Security Model

### Authentication
- **API Key**: All requests require `X-EXPORT-KEY` header
- **Development**: Auto-generated 32-char hex key (logged to console)
- **Production**: Must set `EXPORT_KEY` environment variable (API disabled if not set)

### Whitelisting
Files are scanned using `fast-glob` with strict include/exclude patterns:

**Included Patterns:**
- Config files: `package.json`, `tsconfig.json`, `vite.config.*`, etc.
- Source code: `src/**`, `server/**`, `app/**`, `api/**`, `lib/**`, `shared/**`
- Database: `schema.*`, `migrations/**`, `drizzle.config.*`
- Documentation: `README.md`, `docs/**/*.md`

**Excluded Patterns (Security-Critical):**
- Environment files: `.env*`
- Credentials: `**/*.key`, `**/*.pem`, `**/credentials*`, `**/secrets*`
- Sensitive patterns: `**/*secret*`, `**/*password*`, `**/*token*`
- Build artifacts: `node_modules/**`, `dist/**`, `build/**`
- Binary files: `**/*.png`, `**/*.jpg`, `**/*.pdf`, etc.

### Error Handling
- **Client errors**: Generic messages only (no filesystem paths exposed)
- **Server logs**: Detailed errors with `[Export API]` prefix for debugging
- **Error codes**: `FILE_NOT_WHITELISTED`, `FILE_NOT_FOUND`

## Endpoints

### GET /export/status.json

Returns comprehensive summary of all exportable files.

**Request:**
```bash
curl -H "X-EXPORT-KEY: <your-key>" \
  http://localhost:5000/export/status.json
```

**Response:**
```json
{
  "appName": "Wyshbone Supervisor Suite",
  "generatedAt": "2025-11-13T11:27:31.916Z",
  "totals": {
    "files": 23,
    "sizeBytes": 394486,
    "loc": 11387,
    "todo": 7,
    "fixme": 7
  },
  "quality": {
    "clevernessIndex": 45,
    "hasTypes": true,
    "hasDocs": true,
    "hasApi": true,
    "testsCount": 0
  },
  "files": [
    {
      "path": "package.json",
      "size": 3674,
      "loc": 110,
      "hash": "8a2c9d8..."
    }
  ]
}
```

**Metrics:**
- `clevernessIndex`: Code quality score based on LOC, tests, types, docs, TODOs
- `files`: Total exportable files
- `sizeBytes`: Combined file size
- `loc`: Total lines of code
- `todo`/`fixme`: Count of TODO/FIXME comments

### GET /export/file?path=<file-path>

Returns raw content of a single whitelisted file.

**Request:**
```bash
curl -H "X-EXPORT-KEY: <your-key>" \
  "http://localhost:5000/export/file?path=package.json"
```

**Response:**
```json
{
  "path": "package.json",
  "content": "{\n  \"name\": \"rest-express\",\n  ..."
}
```

**Error Responses:**
- `400`: Missing `path` parameter
- `403`: Invalid or missing API key
- `404`: File not whitelisted or doesn't exist
- `500`: Internal server error

## Usage Examples

### External Status Monitor
```javascript
const response = await fetch('https://your-app.replit.app/export/status.json', {
  headers: { 'X-EXPORT-KEY': process.env.EXPORT_KEY }
});
const { totals, quality } = await response.json();
console.log(`${totals.files} files, ${totals.loc} LOC, cleverness: ${quality.clevernessIndex}`);
```

### AI Code Analysis
```javascript
// Get file list
const status = await fetch('/export/status.json', {
  headers: { 'X-EXPORT-KEY': key }
}).then(r => r.json());

// Download specific files
for (const file of status.files.filter(f => !f.skipped)) {
  const { content } = await fetch(`/export/file?path=${file.path}`, {
    headers: { 'X-EXPORT-KEY': key }
  }).then(r => r.json());
  
  analyzeCode(file.path, content);
}
```

## Maintenance

### Adding New Exclusions
If you add sensitive files to the repo, update the exclusion patterns in `server/utils/exporter.ts`:

```typescript
const EXCLUDE_PATTERNS = [
  // Add new patterns here
  '**/my-new-secret-file.txt',
  '**/*apikey*',
];
```

### Cache Invalidation
The file list is cached in memory. To force a refresh:
```typescript
import { invalidateCache } from './server/utils/exporter';
invalidateCache();
```

### Testing Security
```bash
# Test blocked file returns sanitized error
curl -H "X-EXPORT-KEY: <key>" \
  "http://localhost:5000/export/file?path=.env"
# Expected: {"error":"Not found","message":"Requested file is not available for export"}

# Test missing key returns 403
curl "http://localhost:5000/export/status.json"
# Expected: {"error":"Forbidden","message":"Valid X-EXPORT-KEY header required"}
```

## Security Best Practices

1. **Never commit** the `EXPORT_KEY` to version control
2. **Rotate keys** regularly in production
3. **Monitor logs** for `[Export API]` entries to detect abuse
4. **Review exclusions** whenever adding new files to the repo
5. **Limit access** - only share the key with trusted services
6. **Use HTTPS** - never send the key over unencrypted connections

## Production Deployment

1. Set environment variable:
```bash
export EXPORT_KEY="your-secure-random-key-here"
```

2. Verify it's set:
```bash
# Should NOT see the generated key message
# Should NOT log the key
npm start
```

3. Test endpoint:
```bash
curl -H "X-EXPORT-KEY: your-secure-random-key-here" \
  https://your-app.replit.app/export/status.json
```

## Architecture

```
┌─────────────┐
│   Client    │
│ (AI/Monitor)│
└──────┬──────┘
       │ X-EXPORT-KEY header
       ▼
┌─────────────────────┐
│  checkExportKey()   │  ← Authentication middleware
│  (server/routes.ts) │
└──────┬──────────────┘
       │ Valid key
       ▼
┌─────────────────────┐
│ /export/status.json │  ← File scanning endpoint
│ /export/file        │  ← Single file retrieval
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│  exporter.ts        │  ← Core logic
│  - fast-glob scan   │
│  - Whitelist check  │
│  - File reading     │
│  - Metrics compute  │
└─────────────────────┘
```

## Future Improvements

- Rate limiting per API key
- Audit logging of all export requests
- Configurable file size limits
- Streaming for large files
- Webhook notifications for file changes
