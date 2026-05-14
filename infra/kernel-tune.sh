#!/bin/bash

# ══════════════════════════════════════════════════════════════════════════════
# IICPC Platform Kernel Tuning Script
# 
# Optimizes kernel settings for deterministic, low-latency trading benchmarks.
# Run this on the benchmark host to minimize scheduling jitter and maximize
# performance consistency.
#
# WARNING: Requires root/sudo privileges. Can affect system stability if 
# interrupted or misconfigured. Test in non-production environments first.
# ══════════════════════════════════════════════════════════════════════════════

set -e

echo "========================================="
echo "IICPC Platform Kernel Tuning"
echo "========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "ERROR: This script must be run as root (use sudo)"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. Disable CPU Frequency Scaling
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[1/7] Disabling CPU frequency scaling for deterministic latency..."

# Set CPU governor to 'performance' (disables frequency scaling)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    if [ -f "$cpu" ]; then
        echo "performance" > "$cpu"
        echo "  → Set $(dirname $cpu) to performance"
    fi
done

echo "✓ CPU frequency scaling disabled"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Increase Socket Buffers for High-Speed Networking
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[2/7] Increasing socket receive/transmit buffers..."

sysctl -w net.core.rmem_max=16777216 > /dev/null
sysctl -w net.core.wmem_max=16777216 > /dev/null
sysctl -w net.ipv4.tcp_rmem="4096 87380 16777216" > /dev/null
sysctl -w net.ipv4.tcp_wmem="4096 65536 16777216" > /dev/null

echo "  → rmem_max: 16777216 bytes (16MB)"
echo "  → wmem_max: 16777216 bytes (16MB)"
echo "✓ Socket buffers increased"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Disable Swap to Eliminate Page Faults
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[3/7] Disabling swap (eliminates page faults)..."

# Check current swap usage
SWAP_ENABLED=$(swapon --show | wc -l)

if [ "$SWAP_ENABLED" -gt 1 ]; then
    swapoff -a
    echo "✓ Swap disabled"
else
    echo "✓ Swap already disabled"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Enable Real-Time Scheduling Privileges
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[4/7] Configuring real-time scheduling limits..."

# Check if limits.conf entries already exist
if grep -q "^\* soft rtprio" /etc/security/limits.conf 2>/dev/null; then
    echo "✓ Real-time priorities already configured"
else
    echo "* soft rtprio 99" >> /etc/security/limits.conf
    echo "* hard rtprio 99" >> /etc/security/limits.conf
    echo "* soft memlock unlimited" >> /etc/security/limits.conf
    echo "* hard memlock unlimited" >> /etc/security/limits.conf
    echo "✓ Real-time priority limits configured (99 = max priority)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Reduce Kernel Scheduler Latency
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[5/7] Reducing kernel scheduler latency..."

# sched_latency_ns: Controls how many nanoseconds a task is guaranteed to run
# Lower = more frequent context switches but lower latency for interactive tasks
if [ -f /proc/sys/kernel/sched_latency_ns ]; then
    sysctl -w kernel.sched_latency_ns=3000000 > /dev/null  # 3ms (default 24ms)
    echo "  → sched_latency_ns: 3000000 (3ms)"
fi

# sched_min_granularity_ns: Minimum time slice for a task
if [ -f /proc/sys/kernel/sched_min_granularity_ns ]; then
    sysctl -w kernel.sched_min_granularity_ns=500000 > /dev/null  # 500us (default 4ms)
    echo "  → sched_min_granularity_ns: 500000 (500µs)"
fi

echo "✓ Scheduler latency tuned"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Disable Transparent Huge Pages (THP)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[6/7] Disabling Transparent Huge Pages (eliminates jitter)..."

if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
    echo never > /sys/kernel/mm/transparent_hugepage/enabled
    echo "✓ THP disabled (prevents STW pauses)"
else
    echo "✓ THP not available on this system"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7. Tune Network Stack for Low-Latency
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "[7/7] Tuning network stack parameters..."

# Reduce TCP backlog for faster connection establishment
sysctl -w net.core.somaxconn=65536 > /dev/null
sysctl -w net.ipv4.tcp_max_syn_backlog=65536 > /dev/null

# Disable TCP_NAGLE (Nagle's algorithm) - important for low latency
# This is typically done per-application with TCP_NODELAY
sysctl -w net.ipv4.tcp_tw_reuse=1 > /dev/null
sysctl -w net.ipv4.tcp_tw_recycle=0 > /dev/null

echo "  → somaxconn: 65536"
echo "  → tcp_max_syn_backlog: 65536"
echo "✓ Network stack tuned"

# ─────────────────────────────────────────────────────────────────────────────
# Summary & Recommendations
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================="
echo "✓ Kernel tuning complete!"
echo "========================================="
echo ""
echo "System optimizations applied:"
echo "  ✓ CPU frequency scaling: DISABLED"
echo "  ✓ Socket buffers: 16MB (rx/tx)"
echo "  ✓ Swap: DISABLED"
echo "  ✓ RT priority: 99 (max)"
echo "  ✓ Scheduler latency: 3ms"
echo "  ✓ Transparent hugepages: DISABLED"
echo "  ✓ Network stack: optimized"
echo ""
echo "Recommendations:"
echo "  1. Pin benchmark process to dedicated CPU cores using numactl or taskset"
echo "  2. Run benchmark with NUMA disabled: numactl --localalloc"
echo "  3. Set process priority: chrt -f 99 <command>"
echo "  4. Disable CPU C-states in BIOS for more consistent performance"
echo "  5. Keep system load minimal during benchmarks"
echo ""
echo "Example benchmark command with full tuning:"
echo "  numactl --localalloc chrt -f 99 taskset -c 0-3 ./benchmark --regime=stressed"
echo ""
echo "Note: Some settings require system reboot to persist across reboots."
echo "Add these settings to /etc/sysctl.conf or /etc/sysctl.d/ for persistence."
echo ""
