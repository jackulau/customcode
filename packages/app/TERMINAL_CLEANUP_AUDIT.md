# Terminal Cleanup Audit - Manual Test Plan

## Overview

This document describes the manual test procedure for verifying terminal session isolation, cleanup correctness, and cross-workspace safety after the PTY lifecycle audit.

## Prerequisites

- Application built and running locally
- At least two distinct project directories available
- Ability to open the application dev tools (for debugging if needed)

## Test Procedures

### Test 1: Multiple Terminal Lifecycle

**Purpose**: Verify no content leaks between terminals in the same workspace.

1. Open the application and navigate to a project directory
2. Create 3 terminals (Terminal 1, Terminal 2, Terminal 3)
3. In Terminal 1, run: `echo "TERMINAL_ONE_MARKER"`
4. In Terminal 2, run: `echo "TERMINAL_TWO_MARKER"`
5. In Terminal 3, run: `echo "TERMINAL_THREE_MARKER"`
6. Switch between terminals and verify each shows only its own content
7. **Expected**: Each terminal displays only its own marker text

### Test 2: Close Order Independence

**Purpose**: Verify terminals close cleanly regardless of order.

1. Create 3 terminals with distinct content (as above)
2. Close Terminal 2 (the middle one)
3. Verify Terminal 1 and Terminal 3 still show their correct content
4. Close Terminal 3
5. Verify Terminal 1 still shows its content
6. Create a new terminal - verify it starts clean (no leaked content)
7. **Expected**: Closing any terminal has no effect on others

### Test 3: Terminal Reorder via Drag-and-Drop

**Purpose**: Verify reordering does not cause content swaps.

1. Create 3 terminals, each with distinct output
2. Drag Terminal 3 to the first position
3. Verify Terminal 3 still shows its original content
4. Verify Terminal 1 and Terminal 2 still show their original content
5. Switch between all three terminals
6. **Expected**: Tab reordering preserves each terminal's buffer

### Test 4: App Restart Persistence

**Purpose**: Verify terminal buffers survive restarts correctly.

1. Create 2 terminals with distinct content
2. Note the exact content visible in each terminal
3. Restart the application (close and reopen)
4. Verify both terminals appear with their saved content
5. Verify no content from Terminal 1 appears in Terminal 2 and vice versa
6. **Expected**: Each terminal restores its own content independently

### Test 5: Cross-Workspace Isolation

**Purpose**: Verify no terminal content leaks between workspaces.

1. Open the application in Project Directory A
2. Create a terminal and run: `echo "WORKSPACE_A_CONTENT"`
3. Switch to Project Directory B (different directory)
4. Create a terminal and run: `echo "WORKSPACE_B_CONTENT"`
5. Switch back to Project Directory A
6. Verify the terminal still shows "WORKSPACE_A_CONTENT" and not "WORKSPACE_B_CONTENT"
7. Switch to Project Directory B and verify the same independence
8. **Expected**: Terminal content is fully isolated between workspaces

### Test 6: Terminal Clone Integrity

**Purpose**: Verify cloned terminals inherit buffer but operate independently.

1. Create a terminal and run several commands to build up output
2. Clone the terminal (if clone functionality is available)
3. Verify the clone shows the same buffer content as the original
4. Run a new command in the clone
5. Verify the original terminal does NOT show the new command output
6. **Expected**: Clone starts with the same visual buffer but is independent

### Test 7: Rapid Create/Close Cycle

**Purpose**: Verify no resource leaks or content contamination during rapid operations.

1. Rapidly create 5 terminals in quick succession
2. Type unique text in each one (e.g., the terminal number)
3. Rapidly close all 5 terminals
4. Create a single new terminal
5. Verify the new terminal starts clean
6. **Expected**: No leaked content or stale buffers

### Test 8: PTY Exit Handling

**Purpose**: Verify terminals are cleaned up when the shell process exits.

1. Create a terminal
2. Run a command that exits: `exit`
3. Verify the terminal is removed from the tab bar
4. Verify no orphaned state remains (no phantom tabs)
5. **Expected**: Exited PTY is cleanly removed

## Audit Findings Summary

### Issues Found and Fixed

1. **Server-side subscriber key coupling** (`packages/opencode/src/pty/index.ts`):
   - The subscriber map used `ws.data` as the connection key when it was an object, falling back to `ws` itself. The validation checks (`ws.data === key` and `ws.data !== key`) were incorrect in the fallback case where `connectionKey === ws` (since `ws.data !== ws`). This would cause subscribers to be immediately evicted on the first data event in non-standard WebSocket setups.
   - **Fix**: Use a dedicated empty object `{}` as the connection key. This is always unique (reference identity), never collides, and does not depend on runtime internals. Removed the `ws.data === key` ownership checks from disposal and removal since all subscribers in the map belong to the session.

2. **Disposal handler not closing all WebSockets** (`packages/opencode/src/pty/index.ts`):
   - The disposal handler iterated subscribers with `if (ws.data === key) ws.close()`. When the connection key was the `ws` object itself (fallback case), this condition was false, so WebSockets were not closed during instance disposal.
   - **Fix**: Close WebSockets unconditionally during disposal and removal, since all entries in a session's subscriber map are owned by that session.

### Invariants Verified (No Issues)

1. **Client-side cleanup ordering** (`terminal.tsx`): The `finalized` flag correctly prevents double-persistence from the `output.flush(finalize)` / `setTimeout(finalize, 100)` pattern. The canvas hiding and animation frame cancellation do not interfere with serialization because `SerializeAddon.serialize()` reads from the terminal's internal buffer, not the canvas.

2. **Storage key uniqueness** (`persist.ts`): The `workspaceStorage()` function combines a 12-character head prefix with a 32-bit FNV-1a checksum of the full directory path. The checksum provides the collision resistance (1 in ~4 billion for random inputs), and the head provides human readability. No practical collision risk for typical usage patterns.

3. **Event handler scoping** (`context/terminal.tsx`): The `pty.exited` event handler operates on its own store (the workspace session it was created for). The `findWorkspaceForPty()` helper searches across cached sessions by PTY ID, but PTY IDs are globally unique (timestamp + random bytes), so cross-workspace interference is impossible.

4. **Cache key isolation** (`context/terminal.tsx`): The `clearWorkspaceTerminals()` function uses `getWorkspaceTerminalCacheKey(dir)` which produces `${dir}:__workspace__`. Different directories produce different keys, so clearing one workspace's terminals cannot affect another.
