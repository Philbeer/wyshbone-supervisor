# TLDR CLI - Code Analysis Tool

You have `tldr` available on PATH for token-efficient code analysis.

## TLDR-First File Access Policy (MANDATORY)

**CRITICAL RULE:** Before reading any file over 200 lines or approximately 10KB, you MUST run `tldr extract <file>` or `tldr structure <path>` first.

### Policy Requirements

1. **Check file size before reading:**
   - Files > 200 lines or ~10KB → Use TLDR first
   - Only read small, targeted line ranges afterwards (e.g., Read with offset/limit)

2. **Full-file reads require justification:**
   - You MAY do a full-file read ONLY if you explicitly state: "TLDR not sufficient because..." and provide a clear reason
   - Valid reasons: configuration files, small utilities, TLDR doesn't support file type, etc.

3. **Workflow:**
   ```bash
   # Step 1: Get overview
   tldr extract path/to/large-file.ts

   # Step 2: Read only targeted sections if needed
   # (Use Read tool with offset/limit to get specific line ranges)
   ```

### Why This Matters

- **Token efficiency:** TLDR provides structured summaries using 90% fewer tokens than full reads
- **Context preservation:** More room for implementation work vs. file reading
- **Speed:** Faster understanding of large codebases

### Enforcement

This rule applies to ALL repos in the Wyshbone project:
- wyshbone-ui
- wyshbone-supervisor
- wyshbone-control-tower
- wyshbone-behaviour
- Parent directory work across multiple repos

**Violation:** If you read a large file without using TLDR first and without explicit justification, you're wasting tokens and violating this mandatory policy.

## Commands

```bash
# Core analysis
tldr tree [path]                    # File tree
tldr structure [path] --lang <lang> # Code structure (codemaps)
tldr search <pattern> [path]        # Search files
tldr extract <file>                 # Full file info
tldr context <entry> --project .    # LLM-ready context

# Flow analysis
tldr cfg <file> <function>          # Control flow graph
tldr dfg <file> <function>          # Data flow graph
tldr slice <file> <func> <line>     # Program slice
tldr calls [path]                   # Cross-file call graph

# Codebase analysis
tldr impact <func> [path]           # Who calls this function? (reverse call graph)
tldr dead [path]                    # Find unreachable/dead code
tldr arch [path]                    # Detect architectural layers

# Import analysis
tldr imports <file>                 # Parse imports from a file
tldr importers <module> [path]      # Find all files that import a module

# Quality & testing (NEW)
tldr diagnostics <file|path>        # Type check + lint (pyright/ruff)
tldr change-impact [files...]       # Find tests affected by changes
```

## When to Use

- **Before reading files**: Run `tldr structure .` to see what exists
- **Finding code**: Use `tldr search "pattern"` instead of grep for structured results
- **Understanding functions**: Use `tldr cfg` for complexity, `tldr dfg` for data flow
- **Debugging**: Use `tldr slice file.py func 42` to find what affects line 42
- **Context for tasks**: Use `tldr context entry_point` to get relevant code
- **Impact analysis**: Use `tldr impact func_name` before refactoring to see what would break
- **Dead code**: Use `tldr dead src/` to find unused functions for cleanup
- **Architecture**: Use `tldr arch src/` to understand layer structure
- **Import tracking**: Use `tldr imports file.py` to see what a file imports
- **Reverse imports**: Use `tldr importers module_name src/` to find who imports a module
- **Before tests**: Use `tldr diagnostics .` to catch type errors before running tests
- **Selective testing**: Use `tldr change-impact` to run only affected tests

## Languages

Supports: `python`, `typescript`, `go`, `rust`

## Example Workflow

```bash
# 1. See project structure
tldr tree src/ --ext .py

# 2. Find relevant code
tldr search "process_data" src/

# 3. Get context for a function
tldr context process_data --project src/ --depth 2

# 4. Understand control flow
tldr cfg src/processor.py process_data

# 5. Before refactoring - check impact
tldr impact process_data src/ --depth 3

# 6. Find dead code to clean up
tldr dead src/ --entry main cli
```

## Codebase Analysis Commands

### Impact Analysis
```bash
tldr impact <function> [path] --depth N --file <filter>
```
Shows reverse call graph - all functions that call the target. Useful before refactoring.

### Dead Code Detection
```bash
tldr dead [path] --entry <patterns>
```
Finds functions never called (excluding entry points like main, test_, etc.)

### Architecture Detection
```bash
tldr arch [path]
```
Analyzes call patterns to detect:
- Entry layer (controllers/handlers)
- Middle layer (services)
- Leaf layer (utilities)
- Circular dependencies

### Import Analysis
```bash
tldr imports <file> [--lang python]
```
Parses all import statements from a file. Returns JSON with module names, imported names, aliases.

### Reverse Import Lookup
```bash
tldr importers <module> [path] [--lang python]
```
Finds all files that import a given module. Complements `tldr impact` which tracks function *calls* - this tracks *imports*.

### Diagnostics (Type Check + Lint)
```bash
tldr diagnostics <file>              # Single file
tldr diagnostics . --project         # Whole project
tldr diagnostics src/ --format text  # Human-readable output
tldr diagnostics src/ --no-lint      # Type check only
```
Runs pyright (types) + ruff (lint) and returns structured errors. Use before tests to catch type errors early.

### Change Impact (Selective Testing)
```bash
tldr change-impact                   # Auto-detect (session/git)
tldr change-impact src/foo.py        # Explicit files
tldr change-impact --session         # Session-modified files
tldr change-impact --git             # Git diff files
tldr change-impact --run             # Actually run affected tests
```
Finds which tests to run based on changed code. Uses call graph + import analysis.

## Output

All commands output JSON (except `context` which outputs LLM-ready text, `diagnostics --format text` for human output).
