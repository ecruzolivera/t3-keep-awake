function unavailable(message) {
    return { state: "unknown", filled: false, available: false, counts: null,
        label: message, protection: "Sleep protection unconfirmed", detail: "", legacy: false };
}

function snapshot(text, now, staleMs) {
    var value;
    try { value = JSON.parse(text); } catch (_) { return unavailable("Companion status unavailable"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable("Invalid companion status");
    var updated = Date.parse(value.updatedAt);
    if (!isFinite(updated) || now - updated > staleMs || updated - now > staleMs)
        return unavailable("Companion status is stale");
    if (typeof value.connected !== "boolean" || typeof value.held !== "boolean"
            || !Number.isInteger(value.activeThreads) || value.activeThreads < 0)
        return unavailable("Invalid companion status");
    var counts = value.threadStates;
    var legacy = !counts;
    if (legacy) counts = { working: value.activeThreads, blocked: 0, done: 0, idle: 0, failed: 0 };
    var keys = ["working", "blocked", "done", "idle", "failed"];
    var safeCounts = {};
    for (var i = 0; i < keys.length; i++) {
        if (!Number.isInteger(counts[keys[i]]) || counts[keys[i]] < 0)
            return unavailable("Invalid thread counts");
        safeCounts[keys[i]] = counts[keys[i]];
    }
    counts = safeCounts;
    var protection = value.observing ? "Observe mode: sleep is not inhibited"
        : value.held ? "Sleep inhibitor held" : "Sleep inhibitor released";
    var state = "empty";
    var label = "No counted T3 threads";
    if (value.observing) { state = "unknown"; label = "Observe mode"; }
    else if (value.activeThreads > 0 && !value.held) { state = "error"; label = "Working without sleep protection"; }
    else if (!value.connected) { state = "unknown"; label = "Disconnected from T3"; }
    else if (counts.failed > 0) { state = "error"; label = "A T3 thread failed"; }
    else if (counts.blocked > 0) { state = "blocked"; label = "T3 needs your input"; }
    else if (counts.working > 0) { state = "working"; label = "T3 is working"; }
    else if (counts.done > 0) { state = "done"; label = "T3 work completed"; }
    else if (counts.idle > 0 || legacy) { state = "idle"; label = "T3 is idle"; }
    return { state: state, label: label, protection: protection, counts: counts, legacy: legacy,
        available: value.connected, filled: ["working", "blocked", "done", "error"].indexOf(state) !== -1,
        detail: legacy ? "Upgrade the companion for waiting/completed thread counts." : "Archived and settled threads are excluded from idle/completed counts." };
}

function summary(value) {
    if (!value.counts) return value.label;
    var counts = value.counts;
    return counts.working + " working · " + counts.blocked + " waiting for you · "
        + counts.done + " completed · " + counts.idle + " idle · " + counts.failed + " failed";
}
