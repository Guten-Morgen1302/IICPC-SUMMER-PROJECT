<#
.SYNOPSIS
End-to-End Integration Test for the IICPC Platform

.DESCRIPTION
This script uploads the sample engine, waits for the pipeline to finish,
and verifies that a score was successfully generated.
#>

$ErrorActionPreference = "Stop"

$API_URL = "http://localhost:3001"
$LEADERBOARD_URL = "http://localhost:3008"
$SAMPLE_ENGINE = "..\sample-engine.zip"

Write-Host "=========================================="
Write-Host "🚀 IICPC E2E Integration Test Starting"
Write-Host "=========================================="

if (-not (Test-Path $SAMPLE_ENGINE)) {
    Write-Error "Sample engine not found at $SAMPLE_ENGINE. Please ensure it exists."
    exit 1
}

Write-Host "1. Submitting engine to $API_URL/submit..."
# We use curl.exe as it handles multipart/form-data easily, or Invoke-RestMethod. Let's use curl.exe if available, or just a simple curl wrapper
$submitResult = curl.exe -s -X POST -F "userEmail=e2e-test@example.com" -F "file=@$SAMPLE_ENGINE" "$API_URL/submit"

if ($LASTEXITCODE -ne 0) {
    Write-Error "Submission failed."
    exit 1
}

$submissionData = $submitResult | ConvertFrom-Json
$submissionId = $submissionData.submissionId

if (-not $submissionId) {
    Write-Error "Failed to parse submissionId from response: $submitResult"
    exit 1
}

Write-Host "✅ Submission successful. ID: $submissionId"
Write-Host "2. Polling pipeline status..."

$maxAttempts = 60
$attempt = 0
$isComplete = $false
$finalScore = 0

while ($attempt -lt $maxAttempts) {
    Start-Sleep -Seconds 5
    $attempt++
    
    $statusResult = curl.exe -s "$LEADERBOARD_URL/submissions/$submissionId"
    $statusData = $statusResult | ConvertFrom-Json
    
    $currentStatus = $statusData.pipelineStatus
    Write-Host "   Attempt $attempt/$maxAttempts - Status: $currentStatus"
    
    if ($currentStatus -eq "COMPLETED" -or $currentStatus -eq "EVALUATED") {
        $isComplete = $true
        $finalScore = $statusData.latestScore
        break
    } elseif ($currentStatus -eq "FAILED") {
        Write-Error "Pipeline failed!"
        exit 1
    }
}

if (-not $isComplete) {
    Write-Error "Timeout waiting for pipeline to complete."
    exit 1
}

Write-Host "✅ Pipeline completed successfully!"
Write-Host "3. Verifying Score..."

if ($null -eq $finalScore -or $finalScore -le 0) {
    Write-Error "Score validation failed. Received score: $finalScore"
    exit 1
}

Write-Host "🎉 E2E Test Passed! Final Score: $finalScore"
Write-Host "=========================================="
