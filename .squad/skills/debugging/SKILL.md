# Debugging Skill

## Purpose
Systematic approach to fixing bugs with minimal code churn and maximum test coverage.

## Steps

### 1. Read the Bug Report Carefully
- Note **specific values** mentioned (memory sizes, timing, error codes)
- Note **file references** (suspected files, stack traces)
- Note **reproduction steps** (exact commands, conditions)

### 2. Check the Suspected File First
- If bug report mentions a specific file → read it first
- Look for the pattern described in the bug
- Verify the suspected root cause

### 3. Look for the Pattern in Similar Files
- If the bug is in a handler, check other handlers
- If the bug is in a model, check other models
- Look for copy-paste errors or inconsistent patterns

### 4. Write a Test That Reproduces the Issue BEFORE Fixing
- Demonstrates the bug exists
- Prevents regressions
- Validates the fix works

### 5. Fix Minimally
- Change only what's necessary to fix the bug
- Don't refactor unrelated code
- Don't "clean up while you're there" unless it's directly related
- Smaller diffs = easier review

## Anti-Patterns to Avoid
- ❌ Jumping straight to coding without understanding the bug
- ❌ Fixing multiple issues in one commit
- ❌ Refactoring unrelated code "while you're there"
- ❌ Skipping test coverage because "it's a small fix"
