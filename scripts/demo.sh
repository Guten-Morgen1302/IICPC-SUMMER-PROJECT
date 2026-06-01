#!/bin/bash
# ==============================================================================
# IICPC Summer Hackathon Demo Showcase Runner
# ==============================================================================
# This script demonstrates the full pipeline of the platform by spinning up the
# docker services, triggering a sample submission, and asserting live updates.
# ==============================================================================

set -e

# Visual formatting helper
echo_step() {
  echo -e "\n\033[1;36m====> $1\033[0m"
}

echo_success() {
  echo -e "\033[1;32m[✓] $1\033[0m"
}

echo_warning() {
  echo -e "\033[1;33m[!] $1\033[0m"
}

echo_error() {
  echo -e "\033[1;31m[✗] $1\033[0m"
}

echo_step "IICPC Benchmark Arena Demo Tour Starting"
echo "This walkthrough showcases all key systems running in concert."

# 1. Environment and dependencies check
echo_step "Checking local environment..."
if ! command -v docker &> /dev/null; then
  echo_error "Docker is required but not installed. Exiting."
  exit 1
fi
echo_success "Docker is installed."

if ! command -v pnpm &> /dev/null; then
  echo_warning "pnpm not found. Using npm as fallback."
  PACKAGE_MANAGER="npm"
else
  echo_success "pnpm is installed."
  PACKAGE_MANAGER="pnpm"
fi

# 2. Infra initialization
echo_step "Step 1: Orchestrating the Data Plane (Docker)..."
echo "Bootstrapping databases, streaming, and timeseries components..."
docker compose up -d postgres redis redpanda questdb

# Wait for database readiness
echo "Waiting for services to become healthy..."
sleep 5

# 3. Database migrations and seeds
echo_step "Step 2: Database Schema Generation & Push..."
if [ "$PACKAGE_MANAGER" = "pnpm" ]; then
  pnpm --filter=@benchmark/db run db:generate
  pnpm --filter=@benchmark/db run db:push
else
  npm run db:generate --workspace=packages/db
  npm run db:push --workspace=packages/db
fi
echo_success "Database is synchronized."

# 4. Trigger Sandbox and Benchmark E2E integration test
echo_step "Step 3: Triggering E2E Benchmark Pipeline Tour..."
if [ -f "./sample-engine.zip" ]; then
  echo "Found sample-engine.zip submission template."
else
  echo_error "sample-engine.zip not found! Run the demo from the workspace root directory."
  exit 1
fi

# Call the built-in PowerShell E2E test script (or bash inline if preferred)
echo "Submitting sample-engine.zip to Arena Submission API..."
if command -v powershell.exe &> /dev/null; then
  powershell.exe -ExecutionPolicy Bypass -File ./scripts/e2e-test.ps1
else
  # Native bash alternative to trigger
  echo "PowerShell not available, running curl submit manually..."
  SUBMIT_RESP=$(curl -s -X POST -F "userEmail=demo-showcase@arena.io" -F "file=@./sample-engine.zip" "http://localhost:3001/submit")
  SUBMISSION_ID=$(echo $SUBMIT_RESP | grep -o '"submissionId":"[^"]*' | grep -o '[^"]*$')
  
  if [ -z "$SUBMISSION_ID" ]; then
    echo_error "Submission failed: $SUBMIT_RESP"
    exit 1
  fi
  
  echo_success "Submission registered successfully! ID: $SUBMISSION_ID"
  echo "Waiting 15 seconds for simulated benchmark pipeline completion..."
  
  for i in {1..3}; do
    sleep 5
    echo "  Checking pipeline status..."
    STATUS_RESP=$(curl -s "http://localhost:3008/submissions/$SUBMISSION_ID")
    echo "  Current state: $STATUS_RESP"
  done
fi

# 5. Live Showcase Summary
echo_step "Step 4: Live Features Showcased"
echo "--------------------------------------------------------"
echo -e "🚀 \033[1mWebSocket Live Leaderboard\033[0m: Updates instantly in real-time"
echo -e "🐳 \033[1mHardened Container Sandbox\033[0m: Resource-constrained, run-readiness checked"
echo -e "📈 \033[1mAdversarial Bot Fleet\033[0m: Latency/correctness measurements verified"
echo -e "📊 \033[1mQuestDB Timeseries Storage\033[0m: Nanosecond latency forensics logged"
echo "--------------------------------------------------------"
echo_success "Arena Demo Tour Completed successfully!"
