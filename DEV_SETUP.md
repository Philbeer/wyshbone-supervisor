# Wyshbone Supervisor - Local Development Setup (Windows)

This guide helps you run the Supervisor locally on **Windows** without requiring PostgreSQL or native build tools.

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm** 9+

## Quick Start (2 minutes)

Open PowerShell in the project directory and run these commands:

```powershell
# 1. Install dependencies
npm install

# 2. Create .env file (mock mode - no database needed)
Copy-Item .env.example .env

# 3. Start the dev server
npm run dev
```

The server will start at **http://localhost:5000** in **mock mode**.

> **Mock Mode**: Data won't persist between restarts, but the UI works for testing.

## Understanding the Modes

| Mode | DATABASE_URL | Persistence | Best For |
|------|--------------|-------------|----------|
| Mock (default) | Empty or unset | ❌ No | Quick UI testing |
| SQLite | `file:./dev.db` | ✅ Yes | Dev with persistence (needs build tools) |
| PostgreSQL | `postgresql://...` | ✅ Yes | Production-like dev |

### Option 1: Mock Mode (Recommended for Windows)

This is the default - just run:

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

### Option 2: SQLite (Requires Build Tools)

If you want data persistence and have Visual Studio Build Tools installed:

1. Edit `.env`:
   ```
   DATABASE_URL="file:./dev.db"
   ```

2. Run migration:
   ```powershell
   npm run db:migrate
   ```

3. Start server:
   ```powershell
   npm run dev
   ```

### Option 3: PostgreSQL

Use a local PostgreSQL or cloud PostgreSQL:

1. Edit `.env`:
   ```
   DATABASE_URL="postgresql://user:pass@localhost:5432/dbname"
   ```

2. Push schema:
   ```powershell
   npm run db:push
   ```

3. Start server:
   ```powershell
   npm run dev
   ```

## Database Commands

| Command | Description |
|---------|-------------|
| `npm run db:migrate` | Create SQLite tables (needs build tools) |
| `npm run db:push` | Push schema to PostgreSQL |
| `npm run db:seed` | Add sample data |
| `npm run db:reset` | Delete and recreate SQLite database |

## Troubleshooting

### "NODE_ENV is not recognized"

This is fixed! Make sure you ran `npm install` to get `cross-env`.

### "DATABASE_URL must be set"

Make sure you have a `.env` file. For mock mode:
```powershell
Copy-Item .env.example .env
```

### Server exits immediately

Check the console output for errors. Common issues:
- Missing `.env` file
- Port 5000 already in use

### "Cannot find module 'better-sqlite3'"

This is normal if you don't have build tools. Use mock mode instead (leave `DATABASE_URL` empty).

## Project Structure

```
wyshbone-supervisor/
├── client/           # React frontend (Vite)
├── server/           # Express backend
│   ├── db.ts         # Database connection (supports mock/SQLite/PostgreSQL)
│   ├── schema.ts     # Schema re-exports
│   └── scripts/      # Database scripts
├── shared/           # Shared types and schemas
├── .env              # Your environment variables
└── .env.example      # Template environment file
```

## What Works in Mock Mode

- ✅ Server starts and serves the UI
- ✅ API endpoints respond
- ✅ Lead Finder UI
- ✅ Plans and execution flow
- ❌ Data persistence (resets on restart)
- ❌ Some database-dependent features

## Need a Real Database?

For full functionality with data persistence:

1. **Easiest**: Use a free PostgreSQL database (Neon, Supabase, Railway)
2. **Local**: Install PostgreSQL via Docker:
   ```powershell
   docker run -d --name pg -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:15
   ```
   Then set `DATABASE_URL="postgresql://postgres:dev@localhost:5432/postgres"`
