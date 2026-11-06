import QtQuick
import Quickshell
import Quickshell.Io
import "IndicatorState.js" as State
import "StatusLocation.js" as Location

Item {
    id: root
    property string pluginId: "t3KeepAwake"
    property var pluginService: null
    property string statusPath: Location.statusPath || (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/t3-keep-awake/status.json"
    property int refreshMs: 1000
    property int staleMs: 5000
    property bool stopped: false
    property var snapshot: State.unavailable("Connecting to the companion…")

    function publish(next) {
        if (stopped || JSON.stringify(snapshot) === JSON.stringify(next)) return;
        snapshot = next;
        if (pluginService) pluginService.setGlobalVar(pluginId, "snapshot", next);
    }
    Component.onCompleted: {
        if (pluginService) pluginService.setGlobalVar(pluginId, "snapshot", snapshot);
    }
    Component.onDestruction: stopped = true
    FileView {
        id: statusFile
        path: root.statusPath
        watchChanges: true
        blockLoading: false
        printErrors: false
        onFileChanged: reload()
        onLoaded: root.publish(State.snapshot(text(), Date.now(), root.staleMs))
        onLoadFailed: root.publish(State.unavailable("Companion is stopped or unavailable"))
    }
    Timer {
        interval: root.refreshMs
        running: !root.stopped
        repeat: true
        onTriggered: statusFile.reload()
    }
    IpcHandler {
        target: "t3-keep-awake"
        function status(): string { return JSON.stringify(root.snapshot); }
    }
}
