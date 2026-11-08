import QtQuick
import Quickshell
import qs.Common
import qs.Widgets
import qs.Modules.Plugins
import "IndicatorState.js" as State

PluginComponent {
    id: root
    layerNamespacePlugin: "t3-keep-awake"
    readonly property var snapshot: shared.value
    readonly property var palette: Theme.dank16?.[SessionData.isLightMode ? "light" : "dark"]
    readonly property color stateColor: snapshot.state === "error" || snapshot.state === "blocked"
        ? (palette?.color1 ?? Theme.error)
        : snapshot.state === "done" || snapshot.state === "idle"
        ? (palette?.color2 ?? Theme.success)
        : snapshot.state === "working" ? (palette?.color3 ?? (SessionData.isLightMode ? "#8c6d00" : "#ffda72")) : Theme.surfaceVariantText

    function triggerHoverPopout(widgetHostId) { /* Details remain click-only, like Herdr. */ }
    PluginGlobalVar {
        id: shared
        varName: "snapshot"
        defaultValue: State.unavailable("Connecting to the companion…")
    }
    Component {
        id: iconComponent
        Item {
            implicitWidth: root.iconSize
            implicitHeight: root.iconSize
            Accessible.role: Accessible.Button
            Accessible.name: "T3 Code: " + root.snapshot.label + ". " + root.snapshot.protection
            Accessible.onPressAction: root.triggerPopout()
            Rectangle {
                anchors.centerIn: parent
                width: root.iconSize
                height: root.iconSize
                radius: width / 4
                color: root.snapshot.filled ? root.stateColor : "transparent"
                border.width: root.snapshot.filled ? 0 : 1.5
                border.color: root.stateColor
                StyledText {
                    anchors.centerIn: parent
                    text: "T3"
                    font.pixelSize: root.iconSize * 0.5
                    font.weight: Font.Bold
                    color: root.snapshot.filled ? Theme.surface : root.stateColor
                }
            }
            HoverHandler { cursorShape: Qt.PointingHandCursor }
        }
    }
    horizontalBarPill: iconComponent
    verticalBarPill: iconComponent
    popoutWidth: 420
    popoutContent: Component {
        PopoutComponent {
            headerText: "T3 Code"
            detailsText: root.snapshot.label
            showCloseButton: true
            Column {
                width: parent.width
                spacing: Theme.spacingM
                StyledText {
                    width: parent.width
                    text: State.summary(root.snapshot)
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    color: Theme.surfaceText
                }
                StyledText {
                    width: parent.width
                    text: root.snapshot.protection
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    color: root.stateColor
                }
                StyledText {
                    width: parent.width
                    text: root.snapshot.detail
                    textFormat: Text.PlainText
                    wrapMode: Text.WordWrap
                    color: Theme.surfaceVariantText
                    font.pixelSize: Theme.fontSizeSmall
                }
            }
        }
    }
}
